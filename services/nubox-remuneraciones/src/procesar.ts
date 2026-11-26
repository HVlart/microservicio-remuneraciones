import type { Page } from 'playwright';
import { navegarAFormulario, cambiarMes, descargarArchivo } from './nubox';

export interface RegistroExtraccion {
  id: string;
  contribuyente_id: string;
  codigo_cliente: string;
  nombre_cliente: string;
  periodo_anio: number;
  periodo_mes: number;
}

export interface ResumenExtraccion {
  procesados: number;
  exitosos: number;
  errores: number;
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
  /** Contención 26-11-2026: false rechaza lotes con más de una empresa. */
  permitirMultiempresa: boolean;
}

export function cantidadEmpresas(registros: { codigo_cliente: string }[]): number {
  return new Set(registros.map((r) => String(r.codigo_cliente ?? '').trim())).size;
}

export const MENSAJE_LOTE_BLOQUEADO =
  'Lote con más de una empresa bloqueado temporalmente (incidente libros 26-11-2026). Extraer una empresa por lote.';

export async function procesarRegistros(
  registros: RegistroExtraccion[],
  deps: Dependencias
): Promise<ResumenExtraccion> {
  const resumen: ResumenExtraccion = {
    procesados: 0,
    exitosos: 0,
    errores: 0,
  };

  console.log(`[index] Iniciando procesamiento de ${registros.length} registro/s`);

  // Última barrera de la contención: nunca procesar un lote multiempresa.
  if (!deps.permitirMultiempresa && cantidadEmpresas(registros) > 1) {
    console.error(`[index] ${MENSAJE_LOTE_BLOQUEADO} (${registros.length} registro/s)`);
    for (const registro of registros) {
      resumen.procesados += 1;
      resumen.errores += 1;
      try {
        await deps.marcarError(registro.id, MENSAJE_LOTE_BLOQUEADO);
      } catch (errActualizar) {
        console.error(`[index] No se pudo marcar como error id=${registro.id}:`, errActualizar);
      }
    }
    return resumen;
  }

  // Login único al inicio para evitar que Nubox bloquee tras varios logins.
  let sesion: Awaited<ReturnType<Dependencias['crearSesion']>>;
  try {
    sesion = await deps.crearSesion();
  } catch (err) {
    const mensaje = err instanceof Error ? err.message : String(err);
    console.error(
      `[index] No se pudo crear la sesión de Nubox, marcando ${registros.length} registro/s como error: ${mensaje}`
    );

    // Marcar TODOS los registros como error para que no queden huérfanos en 'en_proceso'.
    for (const registro of registros) {
      resumen.procesados += 1;
      resumen.errores += 1;
      try {
        await deps.marcarError(registro.id, `Fallo de sesión Nubox: ${mensaje}`);
      } catch (errActualizar) {
        console.error(
          `[index] No se pudo marcar como error id=${registro.id}:`,
          errActualizar
        );
      }
    }

    console.log('[index] Procesamiento finalizado (falló la sesión):', resumen);
    return resumen;
  }

  const { browser, page } = sesion;

  try {
    let primerRegistro = true;

    for (const registro of registros) {
      resumen.procesados += 1;
      const etiqueta = `id=${registro.id} (${registro.codigo_cliente} ${registro.periodo_anio}-${registro.periodo_mes})`;

      console.log(
        `[index] [${resumen.procesados}/${registros.length}] Procesando ${etiqueta}`
      );

      try {
        console.log(`[index] Paso 1/3: descargando libro de Nubox`);

        if (primerRegistro) {
          await navegarAFormulario(
            page,
            registro.codigo_cliente,
            registro.periodo_anio,
            registro.periodo_mes
          );
          primerRegistro = false;
        } else {
          await cambiarMes(page, registro.periodo_anio, registro.periodo_mes);
        }

        const buffer = await descargarArchivo(page);
        console.log(`[index] Descarga OK (${buffer.length} bytes)`);

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
        resumen.exitosos += 1;
        console.log(`[index] Registro completado con éxito`);
      } catch (err) {
        resumen.errores += 1;
        const mensaje = err instanceof Error ? err.message : String(err);
        console.error(`[index] Error procesando id=${registro.id}: ${mensaje}`);
        try {
          await deps.marcarError(registro.id, mensaje);
        } catch (errActualizar) {
          console.error(
            `[index] No se pudo actualizar estado a error:`,
            errActualizar
          );
        }
      }

      await deps.esperar(2000);
    }
  } finally {
    await browser.close();
    console.log('[index] Browser cerrado');
  }

  console.log('[index] Procesamiento finalizado:', resumen);
  return resumen;
}
