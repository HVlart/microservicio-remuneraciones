import 'dotenv/config';
import express, { Request, Response } from 'express';
import cron from 'node-cron';
import { crearSesionNubox, descargarLibroRemuneraciones } from './nubox';
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
  console.log(
    `[index] Marcando exitoso id=${id} con nombre_archivo='${nombreArchivo}'`
  );

  // .select() es CLAVE: sin esto, un UPDATE que no encuentra la fila devuelve
  // error=null y data=[], dejando el registro en 'en_proceso' silenciosamente.
  const { data, error } = await supabase
    .from('extracciones_log')
    .update({
      estado: 'exitoso',
      nombre_archivo: nombreArchivo,
    })
    .eq('id', id)
    .select('id');

  if (error) {
    console.error(`[index] ERROR al marcar exitoso (id=${id}):`, error);
    throw new Error(
      `Error al marcar exitoso extracciones_log (id=${id}): ${error.message}`
    );
  }

  if (!data || data.length === 0) {
    console.error(
      `[index] ADVERTENCIA: marcarExitoso no afectó ninguna fila (id=${id}). El registro pudo no existir o el id no coincide.`
    );
    throw new Error(
      `marcarExitoso no afectó ninguna fila en extracciones_log (id=${id})`
    );
  }

  console.log(
    `[index] OK: id=${id} marcado como 'exitoso' (${data.length} fila/s)`
  );
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

  console.log(`[index] Iniciando procesamiento de ${registros.length} registro/s`);

  // Login único al inicio para evitar que Nubox bloquee tras varios logins.
  const { browser, page } = await crearSesionNubox(NUBOX_RUT, NUBOX_PASSWORD);

  try {
    for (const registro of registros) {
      resumen.procesados += 1;
      const etiqueta = `id=${registro.id} (${registro.codigo_cliente} ${registro.periodo_anio}-${registro.periodo_mes})`;

      console.log(
        `[index] [${resumen.procesados}/${registros.length}] Procesando ${etiqueta}`
      );

      try {
        console.log(`[index] Paso 1/3: descargando libro de Nubox para ${etiqueta}`);
        const buffer = await descargarLibroRemuneraciones(
          page,
          registro.codigo_cliente,
          registro.periodo_anio,
          registro.periodo_mes
        );
        console.log(
          `[index] Descarga OK para ${etiqueta} (${buffer.length} bytes)`
        );

        const mesFormateado = String(registro.periodo_mes).padStart(2, '0');
        const nombreArchivo = `${registro.codigo_cliente}_Libro_Remuneraciones_${registro.periodo_anio}_${mesFormateado}.xlsx`;

        console.log(`[index] Paso 2/3: subiendo a Drive '${nombreArchivo}'`);
        const fileId = await subirArchivoDrive(
          nombreArchivo,
          buffer,
          registro.codigo_cliente,
          registro.periodo_anio,
          registro.periodo_mes
        );
        console.log(`[index] Subida a Drive OK para ${etiqueta} (fileId=${fileId})`);

        console.log(`[index] Paso 3/3: actualizando estado en Supabase ${etiqueta}`);
        await marcarExitoso(registro.id, nombreArchivo);
        resumen.exitosos += 1;
        console.log(`[index] Registro ${etiqueta} completado con éxito`);
      } catch (err) {
        resumen.errores += 1;
        const mensaje = err instanceof Error ? err.message : String(err);
        console.error(`[index] Error procesando ${etiqueta}:`, err);
        try {
          await actualizarEstadoExtraccion(registro.id, 'error', {
            mensajeError: mensaje,
          });
        } catch (errActualizar) {
          console.error(
            `[index] No se pudo registrar el estado 'error' para ${etiqueta}:`,
            errActualizar
          );
        }
      }

      // Esperar 3 segundos entre cada registro para no saturar Nubox
      await esperar(3000);
    }
  } finally {
    await browser.close();
    console.log('[index] Browser cerrado');
  }

  console.log('[index] Procesamiento finalizado:', resumen);
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

// Capturar fallos silenciosos para que SIEMPRE queden en los logs de Railway.
process.on('unhandledRejection', (reason) => {
  console.error('[index] unhandledRejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[index] uncaughtException:', err);
});

app.listen(PORT, () => {
  console.log(`nubox-remuneraciones escuchando en el puerto ${PORT}`);
});
