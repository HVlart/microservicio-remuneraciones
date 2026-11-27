/**
 * Doble de la página de Nubox para las pruebas: implementa solo los métodos de
 * Playwright que usa src/nubox.ts y simula el estado del formulario
 * «Reportes > Gestión > Costo Empresa» (empresa, año y mes seleccionados).
 *
 * El reporte descargado es un xlsx con la misma estructura que los reales
 * (revisada el 26-11-2026 en los 487 archivos de Drive): hoja «Reporte Costo
 * Empresa», fila 1 razón social, fila 2 RUT, fila 3 dirección, fila 4 «Nombre»
 * (encabezado de la tabla) y debajo trabajadores, a veces con su RUT.
 *
 * Datos ficticios: ninguna empresa ni RUT de aquí es real.
 */
import { Readable } from 'stream';
import * as XLSX from 'xlsx';
import type { Page } from 'playwright';

const MESES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

export interface EmpresaFalsa {
  codigo: string;
  razonSocial: string;
  /** Con guion y sin puntos, como lo imprime Nubox: 11111111-1 */
  rut: string;
}

export interface OpcionesNuboxFalso {
  empresas: EmpresaFalsa[];
  /** Simula una interfaz que ignora el cambio de empresa después de la primera. */
  ignorarCambioDeEmpresa?: boolean;
  /** Nombre de la hoja del reporte descargado (tipo de reporte). */
  nombreHoja?: string;
  /**
   * Timeouts al generar el reporte: por código de empresa, cuántas veces falla
   * (Infinity = siempre). Tras el timeout la página queda colgada: todo clic
   * falla por timeout hasta volver al inicio (goto) o abrir otra sesión.
   */
  timeoutsAlGenerar?: Record<string, number>;
  /** Cuántas veces el botón «Costo Empresa» da timeout (y la página queda colgada). */
  timeoutsCostoEmpresa?: number;
  /** El goto de vuelta al inicio falla (obliga a abrir una sesión nueva). */
  gotoFalla?: boolean;
  /** El reporte de esta empresa trae siempre el encabezado de otra (código -> código). */
  contenidoDe?: Record<string, string>;
}

export const URL_INICIO_FALSA = 'https://web.nubox.falso/inicio';

export function crearXlsxCostoEmpresa(
  empresa: EmpresaFalsa,
  anio: number,
  mes: number,
  nombreHoja = 'Reporte Costo Empresa'
): Buffer {
  const filas = [
    [empresa.razonSocial],
    [empresa.rut],
    ['CALLE FICTICIA 123, SANTIAGO'],
    ['Nombre', 'RUT', 'Periodo', 'Costo'],
    ['TRABAJADOR FICTICIO UNO', '22222222-2', `${mes}/${anio}`, 1000],
    ['TRABAJADOR FICTICIO DOS', '9.876.543-K', `${mes}/${anio}`, 2000],
    ['TOTALES', '', '', 3000],
  ];
  const libro = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(libro, XLSX.utils.aoa_to_sheet(filas), nombreHoja);
  return XLSX.write(libro, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

type Nombre = string | RegExp | undefined;

export class NuboxFalso {
  pantalla: 'inicio' | 'costo-empresa' = 'inicio';
  private menu: string[] = [];
  empresa: EmpresaFalsa | null = null;
  private desplegableAbierto = false;
  private selectorMesAbierto = false;
  private anio: number | null = null;
  periodo: { anio: number; mes: number } | null = null;
  private esperandoDescarga: Array<(d: unknown) => void> = [];
  /** Códigos elegidos en el desplegable de empresa, en orden. */
  readonly seleccionesEmpresa: string[] = [];
  readonly descargas: Array<{ empresa: string; anio: number; mes: number }> = [];
  /** Intentos de «Generar reporte» por empresa (incluidos los que fallaron). */
  readonly intentosGenerar: Record<string, number> = {};
  colgada = false;
  sesiones = 0;
  private fallosCostoEmpresa = 0;
  readonly gotos: string[] = [];

  constructor(private readonly opciones: OpcionesNuboxFalso) {}

  /** Login nuevo: el estado de la página vuelve a cero. */
  iniciarSesion(): Page {
    this.sesiones += 1;
    this.reiniciarPantalla();
    return this.pagina();
  }

  private reiniciarPantalla(): void {
    this.pantalla = 'inicio';
    this.menu = [];
    this.empresa = null;
    this.periodo = null;
    this.desplegableAbierto = false;
    this.selectorMesAbierto = false;
    this.colgada = false;
    this.esperandoDescarga.splice(0);
  }

  private timeout(que: string): Error {
    return new Error(`locator.click: Timeout 30000ms exceeded. waiting for ${que}`);
  }

  private clic(rol: string, nombre: Nombre): void {
    const n = typeof nombre === 'string' ? nombre : String(nombre);
    if (this.colgada) throw this.timeout(`${rol} '${n}'`);

    if (rol === 'text' && n === 'Remuneraciones 2') {
      // Observado en producción (16-06-2026): desde el formulario del reporte el
      // menú ya no está y el clic espera hasta el timeout.
      if (this.pantalla !== 'inicio') {
        throw new Error("locator.click: Timeout 30000ms exceeded. waiting for getByText('Remuneraciones 2')");
      }
      this.menu = ['remuneraciones'];
      return;
    }

    if (rol === 'button') {
      if (n === 'Reportes' && this.menu.at(-1) === 'remuneraciones') { this.menu.push('reportes'); return; }
      if (n === 'Gestión' && this.menu.at(-1) === 'reportes') { this.menu.push('gestion'); return; }
      if (n === 'Costo Empresa' && this.menu.at(-1) === 'gestion') {
        if (this.fallosCostoEmpresa < (this.opciones.timeoutsCostoEmpresa ?? 0)) {
          this.fallosCostoEmpresa += 1;
          this.colgada = true;
          throw this.timeout("getByRole('button', { name: 'Costo Empresa' })");
        }
        this.pantalla = 'costo-empresa';
        this.empresa = null;
        this.periodo = null;
        this.menu = [];
        return;
      }
      if (this.pantalla !== 'costo-empresa') throw new Error(`Botón '${n}' no visible fuera del formulario`);
      if (n === 'Abrir selector de mes') { this.selectorMesAbierto = true; return; }
      if (n === 'Generar reporte') {
        const cod = this.empresa?.codigo ?? '';
        this.intentosGenerar[cod] = (this.intentosGenerar[cod] ?? 0) + 1;
        const fallas = this.opciones.timeoutsAlGenerar?.[cod] ?? 0;
        if (this.intentosGenerar[cod] <= fallas) {
          this.colgada = true;
          throw this.timeout("getByRole('button', { name: 'Generar reporte' })");
        }
        this.generar();
        return;
      }
      const m = /^(\p{L}+) (\d{4})$/u.exec(n);
      if (m && this.selectorMesAbierto) {
        const mes = MESES.indexOf(m[1]) + 1;
        const anio = Number(m[2]);
        if (mes === 0 || anio !== this.anio) throw new Error(`Botón de mes '${n}' no encontrado`);
        this.periodo = { anio, mes };
        this.selectorMesAbierto = false;
        return;
      }
    }

    if (rol === 'option' && nombre instanceof RegExp) {
      if (!this.desplegableAbierto) throw new Error('Desplegable de empresa cerrado');
      const coincidencias = this.opciones.empresas.filter((e) =>
        nombre.test(`${e.codigo} - ${e.razonSocial}`)
      );
      if (coincidencias.length === 0) throw new Error(`Timeout: opción ${n} no encontrada`);
      if (coincidencias.length > 1) throw new Error(`strict mode violation: ${n} resolved to ${coincidencias.length} elements`);
      this.seleccionesEmpresa.push(coincidencias[0].codigo);
      if (!(this.opciones.ignorarCambioDeEmpresa && this.empresa)) {
        this.empresa = coincidencias[0];
      }
      this.desplegableAbierto = false;
      return;
    }

    throw new Error(`NuboxFalso: clic no soportado (${rol}, ${n})`);
  }

  private generar(): void {
    if (!this.empresa || !this.periodo) throw new Error('Faltan empresa o período');
    const { anio, mes } = this.periodo;
    const otra = this.opciones.contenidoDe?.[this.empresa.codigo];
    const contenido = otra ? this.opciones.empresas.find((e) => e.codigo === otra)! : this.empresa;
    const buffer = crearXlsxCostoEmpresa(contenido, anio, mes, this.opciones.nombreHoja);
    this.descargas.push({ empresa: this.empresa.codigo, anio, mes });
    const descarga = { createReadStream: async () => Readable.from([buffer]) };
    const pendientes = this.esperandoDescarga.splice(0);
    pendientes.forEach((resolver) => resolver(descarga));
  }

  pagina(): Page {
    const localizador = (rol: string, nombre: Nombre) => ({
      click: async () => this.clic(rol, nombre),
      waitFor: async () => {
        if (this.colgada) throw this.timeout(`${rol} '${String(nombre)}'`);
        if (rol === 'text' && nombre === 'Remuneraciones 2' && this.pantalla !== 'inicio') {
          throw this.timeout("getByText('Remuneraciones 2')");
        }
      },
      selectOption: async (valor: string) => {
        if (rol === 'label' && nombre === 'Seleccionar año' && this.selectorMesAbierto) {
          this.anio = Number(valor);
          return [valor];
        }
        throw new Error(`NuboxFalso: selectOption no soportado (${rol}, ${String(nombre)})`);
      },
    });

    const pagina = {
      url: () => (this.pantalla === 'inicio' ? URL_INICIO_FALSA : 'https://web.nubox.falso/reportes/costo-empresa'),
      goto: async (url: string) => {
        this.gotos.push(url);
        if (this.opciones.gotoFalla) throw new Error(`page.goto: Timeout 45000ms exceeded. navigating to "${url}"`);
        if (url !== URL_INICIO_FALSA) throw new Error(`NuboxFalso: goto a URL desconocida ${url}`);
        this.reiniciarPantalla();
        return null;
      },
      getByText: (texto: string) => localizador('text', texto),
      getByRole: (rol: string, op?: { name?: string | RegExp }) => localizador(rol, op?.name),
      getByLabel: (etiqueta: string) => localizador('label', etiqueta),
      locator: (selector: string) => ({
        click: async () => {
          if (this.colgada) throw this.timeout(selector);
          if (selector === '.ui-absolute.ui-right-1' && this.pantalla === 'costo-empresa') {
            this.desplegableAbierto = true;
            return;
          }
          throw new Error(`NuboxFalso: locator no soportado (${selector})`);
        },
      }),
      waitForEvent: (evento: string) => {
        if (evento !== 'download') throw new Error(`NuboxFalso: evento ${evento}`);
        return new Promise((resolver) => this.esperandoDescarga.push(resolver));
      },
    };
    return pagina as unknown as Page;
  }
}
