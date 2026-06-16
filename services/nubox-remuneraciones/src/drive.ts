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

  console.log(
    `[drive] Subiendo '${nombreArchivo}' (cliente=${codigoCliente}, periodo=${anio}-${mes}, ${buffer.length} bytes)`
  );

  const carpetaClienteId = await buscarOCrearCarpeta(
    codigoCliente,
    carpetaRaizId
  );
  const carpetaAnioId = await buscarOCrearCarpeta(
    String(anio),
    carpetaClienteId
  );

  const busqueda = await drive.files.list({
    q: `name = '${escaparNombre(nombreArchivo)}' and '${carpetaAnioId}' in parents and trashed = false`,
    fields: 'files(id, name)',
    spaces: 'drive',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });

  const archivosExistentes = busqueda.data.files ?? [];

  // Si ya existe el archivo, actualizamos su contenido EN SU LUGAR
  // (mismo fileId). Esto evita duplicados y mantiene estable el enlace.
  if (archivosExistentes.length > 0 && archivosExistentes[0].id) {
    const fileId = archivosExistentes[0].id;
    console.log(
      `[drive] Archivo '${nombreArchivo}' ya existe (id=${fileId}). Reemplazando contenido en su lugar...`
    );

    // Si por alguna razón hubiera más de una copia, eliminamos las sobrantes.
    for (const sobrante of archivosExistentes.slice(1)) {
      if (!sobrante.id) continue;
      try {
        await drive.files.delete({
          fileId: sobrante.id,
          supportsAllDrives: true,
        });
        console.log(`[drive] Copia duplicada eliminada (id=${sobrante.id})`);
      } catch (err) {
        console.error(
          `[drive] No se pudo eliminar copia duplicada (id=${sobrante.id}):`,
          err
        );
      }
    }

    const actualizado = await drive.files.update({
      fileId,
      media: {
        mimeType: MIME_XLSX,
        body: Readable.from(buffer),
      },
      fields: 'id',
      supportsAllDrives: true,
    });

    if (!actualizado.data.id) {
      throw new Error(
        `No se pudo actualizar el archivo existente '${nombreArchivo}'`
      );
    }

    console.log(
      `[drive] OK: '${nombreArchivo}' actualizado (id=${actualizado.data.id})`
    );
    return actualizado.data.id;
  }

  console.log(`[drive] Archivo '${nombreArchivo}' no existe. Creando nuevo...`);
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
  return subido.data.id;
}
