import { chromium } from '@playwright/test';

export interface ParamsDescarga {
  codigoCliente: string;
  anio: number;
  mes: number;
  email: string;
  password: string;
}

export async function descargarLibroRemuneraciones(
  params: ParamsDescarga
): Promise<Buffer> {
  const { codigoCliente, anio, mes, email, password } = params;

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();

    // 1. Login en Nubox
    await page.goto('https://app.nubox.cl/login');
    // TODO: verificar selector en DOM de Nubox
    await page.fill('[name="email"]', email);
    // TODO: verificar selector en DOM de Nubox
    await page.fill('[name="password"]', password);
    // TODO: verificar selector en DOM de Nubox
    await page.click('[type="submit"]');
    await page.waitForNavigation();

    // 2. Navegar al módulo de remuneraciones
    // Ir a Reportes → Gestión (ajustar selectores según DOM real de Nubox)
    // TODO: verificar selector en DOM de Nubox
    await page.goto('https://app.nubox.cl/remuneraciones/reportes/gestion');

    // 3. Seleccionar empresa por código C-XXX en el dropdown
    // El dropdown muestra "C-001 - NOMBRE EMPRESA"
    // TODO: verificar selector en DOM de Nubox
    const dropdown = page.locator('select, [role="combobox"]').first();
    // Playwright no acepta RegExp en selectOption, por lo que resolvemos el
    // value de la opción cuyo texto comienza con el código del cliente.
    const valorOpcion = await dropdown
      .locator('option')
      .evaluateAll((opciones, codigo) => {
        const objetivo = (opciones as HTMLOptionElement[]).find((o) =>
          (o.textContent ?? '').trim().startsWith(codigo)
        );
        return objetivo ? objetivo.value : null;
      }, codigoCliente);

    if (valorOpcion === null) {
      throw new Error(
        `No se encontró la empresa con código '${codigoCliente}' en el dropdown`
      );
    }

    await dropdown.selectOption(valorOpcion);

    // 4. Seleccionar período
    // El campo de período acepta formato MM/YYYY
    const mesFormateado = String(mes).padStart(2, '0');
    // TODO: verificar selector en DOM de Nubox
    await page.fill(
      '[name="periodo"], input[type="month"], .periodo-input',
      `${mesFormateado}/${anio}`
    );

    // 5. Interceptar descarga
    const downloadPromise = page.waitForEvent('download');
    // TODO: verificar selector en DOM de Nubox
    await page.click(
      'button:has-text("Generar reporte"), input[value="Generar reporte"]'
    );
    const download = await downloadPromise;

    // 6. Obtener buffer del archivo descargado
    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      stream.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      stream.on('end', () => resolve());
      stream.on('error', reject);
    });

    return Buffer.concat(chunks);
  } finally {
    await browser.close();
  }
}
