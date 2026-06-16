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

  await page.goto('https://web.nubox.com/Login');
  await page.getByRole('textbox', { name: 'Ingresa tu rut' }).fill(rut);
  await page
    .getByRole('textbox', { name: 'Ingresa tu contraseña' })
    .fill(password);
  await page.getByRole('button', { name: 'Ingresar' }).click();

  try {
    await page
      .getByRole('button', { name: 'Acceder de todas formas' })
      .waitFor({ timeout: 5000 });
    await page.getByRole('button', { name: 'Acceder de todas formas' }).click();
  } catch {
    // Modal no apareció
  }

  // Esperar que cargue el dashboard
  await page.getByText('Remuneraciones 2').waitFor({ timeout: 15000 });

  return { browser, page };
}

export async function navegarAFormulario(
  page: Page,
  codigoCliente: string,
  anio: number,
  mes: number
): Promise<void> {
  // Navegar al módulo
  await page.getByText('Remuneraciones 2').click();
  await page.getByRole('button', { name: 'Reportes' }).click();
  await page.getByRole('button', { name: 'Gestión' }).click();
  await page.getByRole('button', { name: 'Costo Empresa' }).click();

  // Seleccionar empresa
  await page.locator('.ui-absolute.ui-right-1').click();
  await page
    .getByRole('option', { name: new RegExp(`^${codigoCliente}`) })
    .click();

  // Seleccionar año y mes
  await page.getByRole('button', { name: 'Abrir selector de mes' }).click();
  await page.getByLabel('Seleccionar año').selectOption(String(anio));
  await page
    .getByRole('button', { name: `${MESES_NOMBRES[mes - 1]} ${anio}` })
    .click();
}

export async function cambiarMes(
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
