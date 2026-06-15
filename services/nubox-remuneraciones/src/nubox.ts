import { chromium } from 'playwright';

export interface ParamsDescarga {
  codigoCliente: string;
  anio: number;
  mes: number;
  rut: string;
  password: string;
}

export async function descargarLibroRemuneraciones(
  params: ParamsDescarga
): Promise<Buffer> {
  const { codigoCliente, anio, mes, rut, password } = params;

  const browser = await chromium.launch({
    headless: false,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    ...(process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD === '1' && {
      executablePath: '/usr/bin/chromium',
    }),
  });

  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();

  try {
    // 1. Login
    await page.goto('https://web.nubox.com/Login');
    await page.getByRole('textbox', { name: 'Ingresa tu rut' }).fill(rut);
    await page
      .getByRole('textbox', { name: 'Ingresa tu contraseña' })
      .fill(password);
    await page.getByRole('button', { name: 'Ingresar' }).click();

    // 2. Manejar modal "Acceder de todas formas" si aparece
    try {
      await page
        .getByRole('button', { name: 'Acceder de todas formas' })
        .waitFor({ timeout: 5000 });
      await page
        .getByRole('button', { name: 'Acceder de todas formas' })
        .click();
    } catch {
      // El modal no apareció, continuar normalmente
    }

    // 3. Navegar a Remuneraciones → Reportes → Gestión → Costo Empresa
    await page.getByText('Remuneraciones 2').click();
    await page.getByRole('button', { name: 'Reportes' }).click();
    await page.getByRole('button', { name: 'Gestión' }).click();
    await page.getByRole('button', { name: 'Costo Empresa' }).click();

    // 4. Seleccionar empresa por código C-XXX
    await page.locator('.ui-absolute.ui-right-1').click();
    await page
      .getByRole('option', { name: new RegExp(`^${codigoCliente}`) })
      .click();

    // 5. Seleccionar período (mes y año)
    await page.getByRole('textbox', { name: 'Periodo del Reporte' }).click();

    // Navegar al año correcto si es necesario
    // El datepicker de Nubox muestra el mes actual por defecto
    // Hacer clic en el mes correcto
    const MESES = [
      'enero',
      'febrero',
      'marzo',
      'abril',
      'mayo',
      'junio',
      'julio',
      'agosto',
      'septiembre',
      'octubre',
      'noviembre',
      'diciembre',
    ];
    const nombreMes = MESES[mes - 1];
    await page.getByRole('button', { name: nombreMes }).click();

    // 6. Interceptar descarga y generar reporte
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Generar reporte' }).click();
    const download = await downloadPromise;

    // 7. Convertir descarga a Buffer
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
