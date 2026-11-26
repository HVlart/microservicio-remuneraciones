import * as XLSX from 'xlsx';

/**
 * Verificación obligatoria del archivo descargado de Nubox ANTES de subirlo a
 * Drive (incidente 26-11-2026: libros con el contenido de otra empresa).
 *
 * Estructura del reporte (revisada en los 487 archivos de Drive el 26-11-2026):
 * hoja «Reporte Costo Empresa»; fila 1 razón social, fila 2 RUT de la empresa,
 * fila 3 dirección, fila 4 «Nombre» (encabezado de la tabla de trabajadores,
 * que puede traer RUT de trabajadores). Solo se mira el bloque anterior a
 * «Nombre», para no confundir el RUT de un trabajador con el de la empresa.
 */

/** Nombre de la hoja que trae Nubox en «Reportes > Gestión > Costo Empresa». */
export const TIPO_REPORTE_ESPERADO = 'Reporte Costo Empresa';

export interface EmpresaEsperada {
  codigo: string;
  razonSocial: string;
  /** Cuerpo del RUT (como contribuyentes.rut). */
  rut: string;
  dv: string;
}

export class ErrorVerificacion extends Error {
  constructor(mensaje: string) {
    super(mensaje);
    this.name = 'ErrorVerificacion';
  }
}

const PATRON_RUT = /^\d{1,2}\.?\d{3}\.?\d{3}-?[\dkK]$/;
const MAX_FILAS_ENCABEZADO = 6;

export function normalizarRut(valor: string): string {
  const limpio = String(valor).replace(/[^0-9kK]/g, '').toUpperCase();
  return limpio.length < 2 ? limpio : `${limpio.slice(0, -1).replace(/^0+/, '')}-${limpio.slice(-1)}`;
}

export function normalizarNombre(valor: string): string {
  return String(valor ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
}

export interface Encabezado {
  hoja: string;
  filas: string[][];
  ruts: string[];
}

export function leerEncabezado(buffer: Buffer): Encabezado {
  let libro: XLSX.WorkBook;
  try {
    libro = XLSX.read(buffer, { type: 'buffer', sheetRows: 20 });
  } catch (err) {
    throw new ErrorVerificacion(
      `El archivo descargado no es un xlsx legible: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  const hoja = libro.SheetNames[0];
  if (!hoja) throw new ErrorVerificacion('El archivo descargado no tiene hojas');

  const todas = XLSX.utils
    .sheet_to_json<unknown[]>(libro.Sheets[hoja], { header: 1, blankrows: false, defval: '' })
    .map((fila) => fila.map((v) => String(v).trim()).filter(Boolean))
    .filter((fila) => fila.length > 0);
  const iTabla = todas.findIndex((fila) => normalizarNombre(fila[0]) === 'NOMBRE');
  const filas = todas.slice(0, iTabla >= 0 ? Math.min(iTabla, MAX_FILAS_ENCABEZADO) : MAX_FILAS_ENCABEZADO);
  const ruts = [...new Set(filas.flat().filter((v) => PATRON_RUT.test(v)).map(normalizarRut))];
  return { hoja, filas, ruts };
}

/**
 * Lanza ErrorVerificacion si el archivo no es el reporte esperado o no es de la
 * empresa esperada. La empresa se reconoce por RUT; si el encabezado no trae
 * RUT, por razón social exacta (normalizada). Un RUT distinto siempre rechaza.
 */
export function verificarReporte(
  buffer: Buffer,
  esperada: EmpresaEsperada,
  tipoEsperado: string = TIPO_REPORTE_ESPERADO
): void {
  const enc = leerEncabezado(buffer);

  if (normalizarNombre(enc.hoja) !== normalizarNombre(tipoEsperado)) {
    throw new ErrorVerificacion(
      `Tipo de reporte inesperado: la hoja es '${enc.hoja}' y se esperaba '${tipoEsperado}'. No se subió a Drive.`
    );
  }

  const rutEsperado = normalizarRut(`${esperada.rut}${esperada.dv}`);
  const otros = enc.ruts.filter((r) => r !== rutEsperado);
  if (otros.length > 0) {
    throw new ErrorVerificacion(
      `El reporte descargado es de otra empresa (RUT del encabezado distinto al de ${esperada.codigo}). No se subió a Drive.`
    );
  }
  if (enc.ruts.includes(rutEsperado)) return;

  const nombre = normalizarNombre(esperada.razonSocial);
  const coincideNombre = nombre.length > 0 && enc.filas.some((f) => f.some((v) => normalizarNombre(v) === nombre));
  if (!coincideNombre) {
    throw new ErrorVerificacion(
      `No se pudo comprobar la empresa del reporte (${esperada.codigo}): el encabezado no trae su RUT ni su razón social. No se subió a Drive.`
    );
  }
}
