import 'dotenv/config';
import express, { Request, Response } from 'express';
import cron from 'node-cron';
import { descargarLibroRemuneraciones } from './nubox';
import { subirArchivoDrive } from './drive';
import { supabase, actualizarEstadoExtraccion } from './supabase';

const PORT = Number(process.env.PORT) || 3001;

interface RegistroExtraccion {
  id: string;
  contribuyente_id: string;
  codigo_cliente: string;
  nombre_cliente: string;
  periodo_anio: number;
  periodo_mes: number;
}

interface ResumenExtraccion {
  procesados: number;
  exitosos: number;
  errores: number;
}

const NUBOX_RUT = process.env.NUBOX_RUT;
const NUBOX_PASSWORD = process.env.NUBOX_PASSWORD;

function esperar(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function marcarExitoso(id: string, nombreArchivo: string): Promise<void> {
  const { error } = await supabase
    .from('extracciones_log')
    .update({
      estado: 'exitoso',
      nombre_archivo: nombreArchivo,
    })
    .eq('id', id);

  if (error) {
    throw new Error(
      `Error al marcar exitoso extracciones_log (id=${id}): ${error.message}`
    );
  }
}

async function procesarRegistros(
  registros: RegistroExtraccion[]
): Promise<ResumenExtraccion> {
  if (!NUBOX_RUT || !NUBOX_PASSWORD) {
    throw new Error(
      'Faltan variables de entorno NUBOX_RUT y/o NUBOX_PASSWORD'
    );
  }

  const resumen: ResumenExtraccion = {
    procesados: 0,
    exitosos: 0,
    errores: 0,
  };

  for (const registro of registros) {
    resumen.procesados += 1;

    try {
      const buffer = await descargarLibroRemuneraciones({
        codigoCliente: registro.codigo_cliente,
        anio: registro.periodo_anio,
        mes: registro.periodo_mes,
        rut: NUBOX_RUT,
        password: NUBOX_PASSWORD,
      });

      const mesFormateado = String(registro.periodo_mes).padStart(2, '0');
      const nombreArchivo = `${registro.codigo_cliente}_Libro_Remuneraciones_${registro.periodo_anio}_${mesFormateado}.xlsx`;

      await subirArchivoDrive(
        nombreArchivo,
        buffer,
        registro.codigo_cliente,
        registro.periodo_anio,
        registro.periodo_mes
      );

      await marcarExitoso(registro.id, nombreArchivo);
      resumen.exitosos += 1;
    } catch (err) {
      resumen.errores += 1;
      const mensaje = err instanceof Error ? err.message : String(err);
      try {
        await actualizarEstadoExtraccion(registro.id, 'error', mensaje);
      } catch (errActualizar) {
        console.error(
          `No se pudo registrar el error para id=${registro.id}:`,
          errActualizar
        );
      }
      console.error(
        `Error procesando registro id=${registro.id} (${registro.codigo_cliente}):`,
        mensaje
      );
    }

    // Esperar 3 segundos entre cada registro para no saturar Nubox
    await esperar(3000);
  }

  return resumen;
}

const app = express();
app.use(express.json());

const autenticar = (
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
): void => {
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== process.env.API_SECRET_KEY) {
    res.status(401).json({ error: 'No autorizado' });
    return;
  }
  next();
};

app.post('/extraer', autenticar, async (req: Request, res: Response) => {
  const registros = req.body?.registros as RegistroExtraccion[] | undefined;

  if (!Array.isArray(registros)) {
    return res
      .status(400)
      .json({ error: 'El cuerpo debe incluir un arreglo "registros"' });
  }

  try {
    const resumen = await procesarRegistros(registros);
    return res.json(resumen);
  } catch (err) {
    const mensaje = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ error: mensaje });
  }
});

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Cron job: día 15 de cada mes a las 03:00 (hora de Santiago)
cron.schedule(
  '0 3 15 * *',
  async () => {
    console.log('[cron] Iniciando extracción automática mensual');
    try {
      await ejecutarExtraccionAutomatica();
    } catch (err) {
      console.error('[cron] Error en la extracción automática:', err);
    }
  },
  { timezone: 'America/Santiago' }
);

async function ejecutarExtraccionAutomatica(): Promise<void> {
  // 1. Consultar contribuyentes con 'remuneraciones' en servicios.
  // Se asume que la columna "servicios" es un arreglo (text[]/jsonb).
  // TODO: ajustar nombre de columna/tabla según el esquema real.
  const { data: contribuyentes, error } = await supabase
    .from('contribuyentes')
    .select('id, codigo_cliente, nombre, servicios')
    .contains('servicios', ['remuneraciones']);

  if (error) {
    throw new Error(`Error consultando contribuyentes: ${error.message}`);
  }

  if (!contribuyentes || contribuyentes.length === 0) {
    console.log('[cron] No hay contribuyentes con servicio de remuneraciones');
    return;
  }

  // 2. Calcular mes anterior al actual (hora de Santiago)
  const ahora = new Date();
  let anio = ahora.getFullYear();
  let mes = ahora.getMonth(); // getMonth() es 0-11; el mes actual sería mes+1, por lo que mes (0-11) representa el mes anterior en base 1
  if (mes === 0) {
    mes = 12;
    anio -= 1;
  }

  // 3. Insertar registros en extracciones_log con estado 'en_proceso' y tipo 'automatica'
  const filas = contribuyentes.map((c: any) => ({
    contribuyente_id: c.id,
    codigo_cliente: c.codigo_cliente,
    nombre_cliente: c.nombre,
    periodo_anio: anio,
    periodo_mes: mes,
    estado: 'en_proceso',
    tipo: 'automatica',
  }));

  const { data: insertados, error: errorInsert } = await supabase
    .from('extracciones_log')
    .insert(filas)
    .select(
      'id, contribuyente_id, codigo_cliente, nombre_cliente, periodo_anio, periodo_mes'
    );

  if (errorInsert) {
    throw new Error(
      `Error insertando en extracciones_log: ${errorInsert.message}`
    );
  }

  if (!insertados || insertados.length === 0) {
    console.log('[cron] No se insertaron registros');
    return;
  }

  // 4. Reutilizar el mismo flujo de extracción que el endpoint POST /extraer
  const resumen = await procesarRegistros(insertados as RegistroExtraccion[]);
  console.log('[cron] Extracción automática finalizada:', resumen);
}

app.listen(PORT, () => {
  console.log(`nubox-remuneraciones escuchando en el puerto ${PORT}`);
});
