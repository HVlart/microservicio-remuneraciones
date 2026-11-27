import 'dotenv/config';
import express, { Request, Response } from 'express';
import cron from 'node-cron';
import { crearSesionNubox } from './nubox';
import { subirArchivoDrive } from './drive';
import { supabase, actualizarEstadoExtraccion, obtenerEmpresaEsperada } from './supabase';
import {
  procesarRegistros as procesar,
  cantidadEmpresas,
  MENSAJE_LOTE_BLOQUEADO,
  RegistroExtraccion,
  ResumenExtraccion,
} from './procesar';
import { contribuyentesParaCron } from './cron';

const PORT = Number(process.env.PORT) || 3001;

const NUBOX_RUT = process.env.NUBOX_RUT;
const NUBOX_PASSWORD = process.env.NUBOX_PASSWORD;

// CONTENCIÓN incidente 26-11-2026 (libros con el contenido de otra empresa):
// procesarRegistros() solo elige la empresa en Nubox para el primer registro del
// lote. Hasta verificar el arreglo, el cron del día 15 queda apagado y se rechaza
// todo lote con más de una empresa. Ambos se reactivan SOLO con la variable en '1'.
const CRON_AUTOMATICO_HABILITADO = process.env.CRON_AUTOMATICO_HABILITADO === '1';
const PERMITIR_LOTE_MULTIEMPRESA = process.env.PERMITIR_LOTE_MULTIEMPRESA === '1';

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
      // Un registro reintentado al final del lote ya tenia el error del primer intento.
      mensaje_error: null,
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
  const rut = NUBOX_RUT;
  const password = NUBOX_PASSWORD;

  return procesar(registros, {
    crearSesion: () => crearSesionNubox(rut, password),
    subirArchivoDrive,
    marcarExitoso,
    marcarError: (id, mensaje) =>
      actualizarEstadoExtraccion(id, 'error', { mensajeError: mensaje }),
    esperar,
    obtenerEmpresa: (r) => obtenerEmpresaEsperada(r.contribuyente_id, r.codigo_cliente),
    permitirMultiempresa: PERMITIR_LOTE_MULTIEMPRESA,
  });
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

app.post('/extraer', autenticar, (req: Request, res: Response) => {
  const registros = req.body?.registros as RegistroExtraccion[] | undefined;

  if (!Array.isArray(registros) || registros.length === 0) {
    res.status(400).json({ error: 'El cuerpo debe incluir un arreglo "registros" no vacío' });
    return;
  }

  if (!PERMITIR_LOTE_MULTIEMPRESA && cantidadEmpresas(registros) > 1) {
    // gestion-contable (enviarLote) marca las filas en error al recibir un no-2xx.
    res.status(409).json({ error: MENSAJE_LOTE_BLOQUEADO });
    return;
  }

  // Responder inmediatamente sin esperar el procesamiento
  res.json({ ok: true, total: registros.length, mensaje: 'Extracción iniciada en background' });

  // Procesar en background sin await
  procesarRegistros(registros).catch(err => {
    console.error('[extraer] Error no capturado en procesarRegistros:', err);
  });
});

app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    commit: (process.env.RAILWAY_GIT_COMMIT_SHA ?? '').slice(0, 7) || null,
    contencion: {
      cronAutomatico: CRON_AUTOMATICO_HABILITADO,
      loteMultiempresa: PERMITIR_LOTE_MULTIEMPRESA,
    },
  });
});

// Disparo manual de la MISMA extracción que corre el cron del día 15,
// para poder probarla sin esperar al próximo mes.
app.post('/ejecutar-automatico', autenticar, (_req: Request, res: Response) => {
  if (!CRON_AUTOMATICO_HABILITADO) {
    res.status(409).json({ error: 'Extracción automática desactivada (incidente libros 26-11-2026)' });
    return;
  }

  // Responder inmediatamente sin esperar el procesamiento
  res.json({ ok: true, mensaje: 'Extracción automática disparada manualmente' });

  console.log('[manual-trigger] Iniciando extracción automática on-demand');

  // Procesar en background sin await
  ejecutarExtraccionAutomatica()
    .then(() => {
      console.log('[manual-trigger] Extracción automática finalizada');
    })
    .catch((err) => {
      console.error('[manual-trigger] Error en la extracción automática:', err);
    });
});

// Cron job: día 15 de cada mes a las 03:00 (hora de Santiago).
// Apagado salvo CRON_AUTOMATICO_HABILITADO=1 (contención 26-11-2026).
if (!CRON_AUTOMATICO_HABILITADO) {
  console.log('[cron] Extracción automática del día 15 DESACTIVADA (CRON_AUTOMATICO_HABILITADO != 1)');
} else cron.schedule(
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
  // 1. Oficiales, activas, con remuneraciones, sin las de prueba, por numero_cliente.
  const contribuyentes = await contribuyentesParaCron(supabase);

  if (!contribuyentes || contribuyentes.length === 0) {
    console.log('[cron] No hay contribuyentes con servicio de remuneraciones');
    return;
  }

  if (!PERMITIR_LOTE_MULTIEMPRESA && contribuyentes.length > 1) {
    console.error(`[cron] ${MENSAJE_LOTE_BLOQUEADO} No se insertan registros.`);
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
  const filas = contribuyentes.map((c) => ({
    contribuyente_id: c.id,
    codigo_cliente: c.numero_cliente,
    nombre_cliente: c.razon_social,
    periodo_anio: anio,
    periodo_mes: mes,
    estado: 'en_proceso',
    tipo_ejecucion: 'automatica',
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
