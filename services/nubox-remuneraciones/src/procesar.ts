import type { Page } from 'playwright';
import {
  abrirReporteCostoEmpresa,
  seleccionarEmpresa,
  seleccionarPeriodo,
  descargarArchivo,
  volverAlFormulario,
} from './nubox';
import { verificarReporte, EmpresaEsperada } from './verificacion';

export interface RegistroExtraccion {
  id: string;
  contribuyente_id: string;
  codigo_cliente: string;
  nombre_cliente: string;
  periodo_anio: number;
  periodo_mes: number;
}

export interface ResumenExtraccion {
  /** Registros con resultado final (exitoso o error), incluidos los que no se alcanzaron a procesar. */
  procesados: number;
  exitosos: number;
  errores: number;
  /** Registros que fallaron y se reintentaron al final del lote. */
  reintentados: number;
  /** true si el lote se detuvo antes de terminar (fallos seguidos o Nubox irrecuperable). */
  detenido: boolean;
}

/**
 * Todo lo que procesarRegistros() necesita del mundo exterior. index.ts pasa las
 * implementaciones reales (Playwright, Drive, Supabase); las pruebas, dobles.
 */
export interface Dependencias {
  crearSesion: () => Promise<{ browser: { close(): Promise<void> }; page: Page }>;
  subirArchivoDrive: (
    nombreArchivo: string,
    buffer: Buffer,
    codigoCliente: string,
    anio: number,
    mes: number
  ) => Promise<string>;
  marcarExitoso: (id: string, nombreArchivo: string) => Promise<void>;
  marcarError: (id: string, mensaje: string) => Promise<void>;
  esperar: (ms: number) => Promise<void>;
  /** Empresa que DEBE venir en el reporte (de contribuyentes); null si no existe. */
  obtenerEmpresa: (registro: RegistroExtraccion) => Promise<EmpresaEsperada | null>;
  /** Contención 26-11-2026: false rechaza lotes con más de una empresa. */
  permitirMultiempresa: boolean;
}

export function cantidadEmpresas(registros: { codigo_cliente: string }[]): number {
  return new Set(registros.map((r) => String(r.codigo_cliente ?? '').trim())).size;
}

export const MENSAJE_LOTE_BLOQUEADO =
  'Lote con más de una empresa bloqueado temporalmente (incidente libros 26-11-2026). Extraer una empresa por lote.';

/** Fallos seguidos (aun recuperando Nubox entre uno y otro) que detienen el lote. */
export const MAX_FALLOS_SEGUIDOS = 3;

/**
 * Sesiones nuevas de Nubox que un lote puede abrir para recuperarse (sin contar
 * el login inicial): muchos logins seguidos pueden hacer que Nubox bloquee la cuenta.
 */
export const MAX_SESIONES_NUEVAS = 5;

export const MOTIVO_TOPE_SESIONES = 'Lote detenido: se alcanzó el máximo de sesiones nuevas por lote';

const MOTIVO_FALLOS_SEGUIDOS =
  `Lote detenido: ${MAX_FALLOS_SEGUIDOS} registros seguidos fallaron incluso después de recuperar Nubox.`;

/**
 * Error de datos (no de Nubox): sin contribuyente no hay contra qué verificar el
 * reporte. Es definitivo: no se recupera Nubox, no se reintenta y no cuenta como
 * fallo seguido.
 */
class ErrorDatos extends Error {}

/** La recuperación necesitaría una sesión nueva más allá de MAX_SESIONES_NUEVAS. */
class ErrorTopeSesiones extends Error {}

const textoError = (err: unknown) => (err instanceof Error ? err.message : String(err));

type Sesion = Awaited<ReturnType<Dependencias['crearSesion']>>;

export async function procesarRegistros(
  registros: RegistroExtraccion[],
  deps: Dependencias
): Promise<ResumenExtraccion> {
  const resumen: ResumenExtraccion = {
    procesados: 0,
    exitosos: 0,
    errores: 0,
    reintentados: 0,
    detenido: false,
  };

  console.log(`[index] Iniciando procesamiento de ${registros.length} registro/s`);

  /** Resultado final de un registro como error (nunca lanza). */
  const errorFinal = async (registro: RegistroExtraccion, mensaje: string) => {
    resumen.procesados += 1;
    resumen.errores += 1;
    try {
      await deps.marcarError(registro.id, mensaje);
    } catch (errActualizar) {
      console.error(`[index] No se pudo marcar como error id=${registro.id}:`, errActualizar);
    }
  };

  // Última barrera de la contención: nunca procesar un lote multiempresa.
  if (!deps.permitirMultiempresa && cantidadEmpresas(registros) > 1) {
    console.error(`[index] ${MENSAJE_LOTE_BLOQUEADO} (${registros.length} registro/s)`);
    for (const registro of registros) await errorFinal(registro, MENSAJE_LOTE_BLOQUEADO);
    return resumen;
  }

  // Login único al inicio para evitar que Nubox bloquee tras varios logins.
  let sesion: Sesion | null;
  try {
    sesion = await deps.crearSesion();
  } catch (err) {
    const mensaje = textoError(err);
    console.error(
      `[index] No se pudo crear la sesión de Nubox, marcando ${registros.length} registro/s como error: ${mensaje}`
    );
    // Marcar TODOS los registros como error para que no queden huérfanos en 'en_proceso'.
    for (const registro of registros) await errorFinal(registro, `Fallo de sesión Nubox: ${mensaje}`);
    console.log('[index] Procesamiento finalizado (falló la sesión):', resumen);
    return resumen;
  }

  // Página a la que llegó el login: desde ahí se vuelve al formulario tras un fallo.
  let urlInicio = sesion.page.url();
  let formularioAbierto = false;
  let necesitaRecuperar = false;
  let fallosSeguidos = 0;
  let sesionesNuevas = 0;

  const cerrarSesion = async () => {
    const actual = sesion;
    sesion = null;
    if (!actual) return;
    try {
      await actual.browser.close();
      console.log('[index] Browser cerrado');
    } catch (err) {
      console.error('[index] No se pudo cerrar el browser:', textoError(err));
    }
  };

  /**
   * Deja Nubox en el formulario después de un fallo: primero lo reabre en la
   * misma sesión y, si eso falla, cierra la sesión y abre una nueva (el
   * formulario se abre en el siguiente intento). Lanza si tampoco hay sesión nueva.
   */
  const recuperar = async () => {
    await deps.esperar(5000);
    if (sesion) {
      try {
        await volverAlFormulario(sesion.page, urlInicio);
        formularioAbierto = true;
        console.log('[index] Recuperación: formulario reabierto');
        return;
      } catch (err) {
        console.error(`[index] Recuperación: no se pudo reabrir el formulario: ${textoError(err)}`);
      }
    }
    if (sesionesNuevas >= MAX_SESIONES_NUEVAS) {
      throw new ErrorTopeSesiones(`${MOTIVO_TOPE_SESIONES} (${MAX_SESIONES_NUEVAS}).`);
    }
    await cerrarSesion();
    formularioAbierto = false;
    sesionesNuevas += 1;
    sesion = await deps.crearSesion();
    urlInicio = sesion.page.url();
    console.log('[index] Recuperación: sesión nueva de Nubox');
  };

  /** Descarga, verifica y sube un registro. Lanza si algo falla. */
  const intentar = async (registro: RegistroExtraccion) => {
    let esperada: EmpresaEsperada | null;
    try {
      esperada = await deps.obtenerEmpresa(registro);
    } catch (err) {
      throw new ErrorDatos(textoError(err));
    }
    if (!esperada) {
      throw new ErrorDatos(
        `No se encontró el contribuyente de ${registro.codigo_cliente}: no se puede verificar el reporte. No se descargó ni se subió.`
      );
    }
    if (!sesion) throw new Error('Sin sesión de Nubox');
    const page = sesion.page;

    console.log(`[index] Paso 1/3: descargando libro de Nubox`);
    if (!formularioAbierto) {
      await abrirReporteCostoEmpresa(page);
      formularioAbierto = true;
    }
    // La empresa se elige en CADA registro (incidente 26-11-2026).
    await seleccionarEmpresa(page, registro.codigo_cliente);
    await seleccionarPeriodo(page, registro.periodo_anio, registro.periodo_mes);

    const buffer = await descargarArchivo(page);
    console.log(`[index] Descarga OK (${buffer.length} bytes)`);

    // Obligatoria, también en los reintentos: si el encabezado no es de la empresa
    // esperada o el reporte no es del tipo esperado, lanza y no se sube nada.
    verificarReporte(buffer, esperada);
    console.log(`[index] Verificación OK: tipo de reporte y empresa ${esperada.codigo}`);

    const mesFormateado = String(registro.periodo_mes).padStart(2, '0');
    const nombreArchivo = `${registro.codigo_cliente}_Libro_Remuneraciones_${registro.periodo_anio}_${mesFormateado}.xlsx`;

    console.log(`[index] Paso 2/3: subiendo a Drive '${nombreArchivo}'`);
    await deps.subirArchivoDrive(
      nombreArchivo,
      buffer,
      registro.codigo_cliente,
      registro.periodo_anio,
      registro.periodo_mes
    );
    console.log(`[index] Subida a Drive OK`);

    console.log(`[index] Paso 3/3: actualizando estado en Supabase`);
    await deps.marcarExitoso(registro.id, nombreArchivo);
  };

  type Resultado =
    | { tipo: 'exitoso' }
    | { tipo: 'definitivo' }
    | { tipo: 'fallo'; mensaje: string }
    /** mensaje: error de este registro si su fallo fue el que detuvo el lote; sin mensaje, no se intentó. */
    | { tipo: 'detenido'; motivo: string; mensaje?: string };

  /** Un intento de un registro, con la recuperación pendiente del fallo anterior. */
  const procesarUno = async (registro: RegistroExtraccion, etiqueta: string): Promise<Resultado> => {
    console.log(`[index] ${etiqueta} Procesando id=${registro.id}`);
    if (necesitaRecuperar) {
      try {
        await recuperar();
        necesitaRecuperar = false;
      } catch (err) {
        if (err instanceof ErrorTopeSesiones) return { tipo: 'detenido', motivo: err.message };
        return {
          tipo: 'detenido',
          motivo: `Lote detenido: no se pudo recuperar Nubox (falló reabrir el formulario y también abrir una sesión nueva): ${textoError(err)}`,
        };
      }
    }
    try {
      await intentar(registro);
      resumen.procesados += 1;
      resumen.exitosos += 1;
      fallosSeguidos = 0;
      console.log(`[index] Registro completado con éxito`);
      return { tipo: 'exitoso' };
    } catch (err) {
      const mensaje = textoError(err);
      console.error(`[index] Error procesando id=${registro.id}: ${mensaje}`);
      if (err instanceof ErrorDatos) {
        await errorFinal(registro, mensaje);
        return { tipo: 'definitivo' };
      }
      fallosSeguidos += 1;
      necesitaRecuperar = true;
      if (fallosSeguidos >= MAX_FALLOS_SEGUIDOS) {
        return { tipo: 'detenido', motivo: MOTIVO_FALLOS_SEGUIDOS, mensaje };
      }
      return { tipo: 'fallo', mensaje };
    }
  };

  /** Pone en error todo lo que queda (fallidos sin reintentar y no procesados). */
  const detener = async (
    motivo: string,
    pendientes: Array<{ registro: RegistroExtraccion; mensaje: string }>,
    noProcesados: RegistroExtraccion[]
  ) => {
    resumen.detenido = true;
    console.error(
      `[index] ${motivo} Quedan en error: ${pendientes.length} fallido/s sin reintentar y ${noProcesados.length} sin procesar`
    );
    for (const p of pendientes) {
      await errorFinal(p.registro, `${motivo} No se reintentó. Último error de este registro: ${p.mensaje}`);
    }
    for (const r of noProcesados) {
      await errorFinal(r, `${motivo} No se procesó este registro: se puede extraer en un lote nuevo.`);
    }
  };

  try {
    const pendientes: Array<{ registro: RegistroExtraccion; mensaje: string }> = [];

    // Pasada principal.
    for (const [i, registro] of registros.entries()) {
      const r = await procesarUno(registro, `[${i + 1}/${registros.length}]`);
      if (r.tipo === 'fallo') {
        pendientes.push({ registro, mensaje: r.mensaje });
        // Queda en error mientras tanto: si el proceso muere, no queda en 'en_proceso'.
        try {
          await deps.marcarError(registro.id, `${r.mensaje} (se reintentará al final del lote)`);
        } catch (errActualizar) {
          console.error(`[index] No se pudo marcar como error id=${registro.id}:`, errActualizar);
        }
      }
      if (r.tipo === 'detenido') {
        // Si este registro falló, va con los fallidos; si no se intentó, con los no procesados.
        const intentado = r.mensaje !== undefined;
        const fallidos = intentado ? [...pendientes, { registro, mensaje: r.mensaje! }] : pendientes;
        await detener(r.motivo, fallidos, registros.slice(intentado ? i + 1 : i));
        return resumen;
      }
      await deps.esperar(2000);
    }

    // Un reintento por registro fallido, al final del lote.
    for (const [j, p] of pendientes.entries()) {
      const r = await procesarUno(p.registro, `[reintento ${j + 1}/${pendientes.length}]`);
      if (!(r.tipo === 'detenido' && r.mensaje === undefined)) resumen.reintentados += 1;
      if (r.tipo === 'fallo') {
        await errorFinal(
          p.registro,
          `Falló también al reintentarlo al final del lote: ${r.mensaje} (primer intento: ${p.mensaje})`
        );
      }
      if (r.tipo === 'detenido') {
        const faltan = pendientes.slice(j + 1);
        if (r.mensaje !== undefined) {
          await errorFinal(
            p.registro,
            `${r.motivo} Falló también al reintentarlo: ${r.mensaje} (primer intento: ${p.mensaje})`
          );
        } else {
          faltan.unshift(p);
        }
        await detener(r.motivo, faltan, []);
        return resumen;
      }
      await deps.esperar(2000);
    }
  } finally {
    await cerrarSesion();
  }

  console.log('[index] Procesamiento finalizado:', resumen);
  return resumen;
}
