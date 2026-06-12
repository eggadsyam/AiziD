import app from './app.js';
import { initDb } from './models.js';

const PORT = process.env.PORT || 5050;

async function startServer() {
  try {
    console.log("Menginisialisasi database...");
    await initDb();
    console.log("Database siap.");

    app.listen(PORT, () => {
      console.log(`Server Node.js berjalan pada port ${PORT}`);
      console.log(`Buka http://localhost:${PORT} untuk mengakses dashboard`);
    });
  } catch (err) {
    console.error("Gagal memulai server:", err);
    process.exit(1);
  }
}

startServer();
