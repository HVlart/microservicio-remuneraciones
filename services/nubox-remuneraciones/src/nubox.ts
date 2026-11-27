import { chromium, Browser, Page } from 'playwright';

const MESES_NOMBRES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

export async function crearSesionNubox(
  rut: string,
  password: string
): Promise<{ browser: Browser; page: Page }> {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    ...(process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD === '1' && {
      executablePath: '/usr/bin/chromium',
    }),
  });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();

  const MAX_INTENTOS = 3;
  let ultimoError: unknown = null;

  for (let intento = 1; intento <= MAX_INTENTOS; intento++) {
    try {
      console.log(`[nubox] Intento de login ${intento}/${MAX_INTENTOS}`);

      await page.goto('https://web.nubox.com/Login', {
        timeout: 45000,
        waitUntil: 'domcontentloaded',
      });
      await page.getByRole('textbox', { name: 'Ingresa tu rut' }).fill(rut);
      await page
        .getByRole('textbox', { name: 'Ingresa tu contraseña' })
        .fill(password);
      await page.getByRole('button', { name: 'Ingresar' }).click();

      try {
        await page
          .getByRole('button', { name: 'Acceder de todas formas' })
          .waitFor({ timeout: 5000 });
        await page
          .getByRole('button', { name: 'Acceder de todas formas' })
          .click();
      } catch {
        // Modal no apareció
      }

      // Esperar que cargue el dashboard
      await page.getByText('Remuneraciones 2').waitFor({ timeout: 15000 });

      console.log('[nubox] Sesión iniciada correctamente');
      return { browser, page };
    } catch (err) {
      ultimoError = err;
      console.error(
        `[nubox] Fallo intento ${intento}/${MAX_INTENTOS}:`,
        err instanceof Error ? err.message : err
      );
      if (intento < MAX_INTENTOS) {
        await page.waitForTimeout(5000);
      }
    }
  }

  await browser.close();
  throw new Error(
    `No se pudo iniciar sesión en Nubox tras ${MAX_INTENTOS} intentos: ${
      ultimoError instanceof Error ? ultimoError.message : String(ultimoError)
    }`
  );
}

/**
 * Abre «Remuneraciones 2 > Reportes > Gestión > Costo Empresa». Va UNA vez por
 * sesión: desde el formulario del reporte el menú ya no está disponible
 * (16-06-2026: los reintentos de navegar en cada registro fallaron por timeout).
 */
export async function abrirReporteCostoEmpresa(page: Page): Promise<void> {
  await page.getByText('Remuneraciones 2').click();
  await page.getByRole('button', { name: 'Reportes' }).click();
  await page.getByRole('button', { name: 'Gestión' }).click();
  await page.getByRole('button', { name: 'Costo Empresa' }).click();
}

/**
 * Recupera el formulario tras un fallo (timeout u otro error de Nubox): desde el
 * formulario el menú no está, así que vuelve a la página de inicio de la sesión
 * (la URL a la que llegó el login), espera el menú y abre el reporte de nuevo.
 * Si esto falla, quien llama cierra la sesión y abre otra.
 */
export async function volverAlFormulario(page: Page, urlInicio: string): Promise<void> {
  await page.goto(urlInicio, { timeout: 45000, waitUntil: 'domcontentloaded' });
  await page.getByText('Remuneraciones 2').waitFor({ timeout: 15000 });
  await abrirReporteCostoEmpresa(page);
}

/**
 * Elige la empresa en el formulario ya abierto. Va en CADA registro: el
 * formulario conserva la empresa anterior y, sin esto, el reporte sale de la
 * primera empresa del lote (incidente 26-11-2026).
 */
export async function seleccionarEmpresa(
  page: Page,
  codigoCliente: string
): Promise<void> {
  await page.locator('.ui-absolute.ui-right-1').click();
  await page
    .getByRole('option', { name: new RegExp(`^${codigoCliente}`) })
    .click();
}

export async function seleccionarPeriodo(
  page: Page,
  anio: number,
  mes: number
): Promise<void> {
  await page.getByRole('button', { name: 'Abrir selector de mes' }).click();
  // Cambiar año (Nubox siempre lo muestra; seleccionar el correcto aunque ya esté)
  await page.getByLabel('Seleccionar año').selectOption(String(anio));
  await page
    .getByRole('button', { name: `${MESES_NOMBRES[mes - 1]} ${anio}` })
    .click();
}

export async function descargarArchivo(page: Page): Promise<Buffer> {
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Generar reporte' }).click();
  const download = await downloadPromise;

  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    stream.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    stream.on('end', () => resolve());
    stream.on('error', reject);
  });

  return Buffer.concat(chunks);
}
