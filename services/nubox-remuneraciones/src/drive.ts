import { google, drive_v3 } from 'googleapis';
import { Readable } from 'stream';

const MIME_FOLDER = 'application/vnd.google-apps.folder';
const MIME_XLSX =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

let driveSingleton: drive_v3.Drive | null = null;

function getDriveClient(): drive_v3.Drive {
  if (driveSingleton) {
    return driveSingleton;
  }

  const clientEmail = process.env.GOOGLE_CLIENT_EMAIL;
  const privateKeyRaw = process.env.GOOGLE_PRIVATE_KEY;

  if (!clientEmail || !privateKeyRaw) {
    throw new Error(
      'Faltan variables de entorno GOOGLE_CLIENT_EMAIL y/o GOOGLE_PRIVATE_KEY'
    );
  }

  const privateKey = privateKeyRaw.replace(/\\n/g, '\n');

  const auth = new google.auth.JWT({
    email: clientEmail,
    key: privateKey,
    scopes: ['https://www.googleapis.com/auth/drive'],
  });

  driveSingleton = google.drive({ version: 'v3', auth });
  return driveSingleton;
}

function escaparNombre(nombre: string): string {
  return nombre.replace(/'/g, "\\'");
}

export async function buscarOCrearCarpeta(
  nombre: string,
  padreId: string,
  drive: drive_v3.Drive = getDriveClient()
): Promise<string> {
  const nombreEscapado = escaparNombre(nombre);

  const respuesta = await drive.files.list({
    q: `name = '${nombreEscapado}' and mimeType = '${MIME_FOLDER}' and '${padreId}' in parents and trashed = false`,
    fields: 'files(id, name)',
    spaces: 'drive',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });

  const existentes = respuesta.data.files ?? [];
  if (existentes.length > 0 && existentes[0].id) {
    console.log(
      `[drive] Carpeta '${nombre}' ya existe (id=${existentes[0].id}) dentro de ${padreId}`
    );
    return existentes[0].id;
  }

  console.log(`[drive] Creando carpeta '${nombre}' dentro de ${padreId}`);
  const creada = await drive.files.create({
    requestBody: {
      name: nombre,
      mimeType: MIME_FOLDER,
      parents: [padreId],
    },
    fields: 'id',
    supportsAllDrives: true,
  });

  if (!creada.data.id) {
    throw new Error(`No se pudo crear la carpeta '${nombre}'`);
  }

  console.log(`[drive] Carpeta '${nombre}' creada (id=${creada.data.id})`);
  return creada.data.id;
}

/**
 * Sube el libro a <raíz>/<código>/<año>/. Si ya hay un archivo con ese nombre,
 * NO se reemplaza su contenido con files.update: la versión anterior quedaría
 * en el historial de versiones (incidente 26-11-2026). Se crea un archivo nuevo
 * y los anteriores van a la papelera (la cuenta de servicio es «gestor de
 * contenido»: no puede borrar definitivamente; la papelera la vacía un
 * administrador). Todas las búsquedas excluyen la papelera.
 */
export async function subirArchivoDrive(
  nombreArchivo: string,
  buffer: Buffer,
  codigoCliente: string,
  anio: number,
  mes: number,
  drive: drive_v3.Drive = getDriveClient()
): Promise<string> {
  const carpetaRaizId = process.env.DRIVE_FOLDER_ID;
  if (!carpetaRaizId) {
    throw new Error('Falta la variable de entorno DRIVE_FOLDER_ID');
  }

  console.log(
    `[drive] Subiendo '${nombreArchivo}' (cliente=${codigoCliente}, periodo=${anio}-${mes}, ${buffer.length} bytes)`
  );

  const carpetaClienteId = await buscarOCrearCarpeta(
    codigoCliente,
    carpetaRaizId,
    drive
  );
  const carpetaAnioId = await buscarOCrearCarpeta(
    String(anio),
    carpetaClienteId,
    drive
  );

  const busqueda = await drive.files.list({
    q: `name = '${escaparNombre(nombreArchivo)}' and '${carpetaAnioId}' in parents and trashed = false`,
    fields: 'files(id, name)',
    spaces: 'drive',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  const anteriores = (busqueda.data.files ?? [])
    .map((f) => f.id)
    .filter((id): id is string => Boolean(id));

  const subido = await drive.files.create({
    requestBody: {
      name: nombreArchivo,
      parents: [carpetaAnioId],
    },
    media: {
      mimeType: MIME_XLSX,
      body: Readable.from(buffer),
    },
    fields: 'id',
    supportsAllDrives: true,
  });

  if (!subido.data.id) {
    throw new Error(`No se pudo subir el archivo '${nombreArchivo}'`);
  }
  console.log(`[drive] OK: '${nombreArchivo}' creado (id=${subido.data.id})`);

  // Recién con el nuevo arriba, los anteriores van a la papelera (solo metadatos:
  // trashed = true; su contenido no se toca).
  const fallidos: string[] = [];
  for (const id of anteriores) {
    try {
      await drive.files.update({
        fileId: id,
        requestBody: { trashed: true },
        fields: 'id',
        supportsAllDrives: true,
      });
      console.log(`[drive] Versión anterior a la papelera (id=${id})`);
    } catch (err) {
      console.error(
        `[drive] No se pudo mandar a la papelera (id=${id}):`,
        err instanceof Error ? err.message : err
      );
      fallidos.push(id);
    }
  }
  if (fallidos.length > 0) {
    throw new Error(
      `Se subió '${nombreArchivo}' (id=${subido.data.id}) pero no se pudo mandar a la papelera la versión anterior (${fallidos.join(', ')}): quedan dos archivos con el mismo nombre`
    );
  }

  return subido.data.id;
}
