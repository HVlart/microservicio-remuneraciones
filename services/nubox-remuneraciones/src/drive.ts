import { google, drive_v3 } from 'googleapis';
import { Readable } from 'stream';

const MIME_FOLDER = 'application/vnd.google-apps.folder';
const MIME_XLSX =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function getDriveClient(): drive_v3.Drive {
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

  return google.drive({ version: 'v3', auth });
}

function escaparNombre(nombre: string): string {
  return nombre.replace(/'/g, "\\'");
}

export async function buscarOCrearCarpeta(
  nombre: string,
  padreId: string
): Promise<string> {
  const drive = getDriveClient();
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
    return existentes[0].id;
  }

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

  return creada.data.id;
}

export async function subirArchivoDrive(
  nombreArchivo: string,
  buffer: Buffer,
  codigoCliente: string,
  anio: number,
  mes: number
): Promise<string> {
  const drive = getDriveClient();

  const carpetaRaizId = process.env.DRIVE_FOLDER_ID;
  if (!carpetaRaizId) {
    throw new Error('Falta la variable de entorno DRIVE_FOLDER_ID');
  }

  const carpetaClienteId = await buscarOCrearCarpeta(
    codigoCliente,
    carpetaRaizId
  );
  const carpetaAnioId = await buscarOCrearCarpeta(
    String(anio),
    carpetaClienteId
  );

  const busqueda = await drive.files.list({
    q: `name='${escaparNombre(nombreArchivo)}' and '${carpetaAnioId}' in parents and trashed=false`,
    fields: 'files(id)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });

  const archivosExistentes = busqueda.data.files ?? [];

  for (const archivo of archivosExistentes) {
    try {
      await drive.files.delete({
        fileId: archivo.id!,
        supportsAllDrives: true,
      });
    } catch {
      // Si el archivo ya no existe, continuar
    }
  }

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

  return subido.data.id;
}
