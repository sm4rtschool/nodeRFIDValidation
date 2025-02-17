// server.js
const mysql = require('mysql2/promise');
const WebSocket = require('ws');
const dotenv = require('dotenv');
const TagProcessModel = require('./models/TagProcessModel');

// Load environment variables
dotenv.config();

// Database configuration
const dbConfig = {
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT
};

// Create database connection pool
const pool = mysql.createPool(dbConfig);

// Initialize model
const tagProcessModel = new TagProcessModel(pool);

// WebSocket server initialization
const wss = new WebSocket.Server({ port: process.env.WS_PORT || 8080 });

// Variable to store interval reference
let processInterval;

// WebSocket connection handler
wss.on('connection', (ws) => {
  console.log('New client connected');
  
  ws.on('close', () => {
    console.log('Client disconnected');
  });
});

// Broadcast function to send data to all connected clients
const broadcastData = (data) => {
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
};

// Function to start/restart the process interval
async function initializeProcessInterval() {
  // Clear existing interval if any
  if (processInterval) {
    clearInterval(processInterval);
  }
  
  // Get interval from database using model
  const intervalTime = await tagProcessModel.getIntervalConfig();
  
  // Start new interval
  processInterval = setInterval(processTagData, intervalTime);
  console.log(`Process interval set to ${intervalTime}ms`);
}

// Main processing function
async function processTagData() {

    try {
    const rows = await tagProcessModel.getTempTableData();
    console.log(`Total Data Last Update: ${rows.length}`);
    
    // Get system settings
    const pengaturanSistem = await tagProcessModel.getPengaturanSistem();
    
    const flag_moving_in = pengaturanSistem.flag_moving_in;
    const flag_moving_out = pengaturanSistem.flag_moving_out;

    for (const row of rows) {

        const { 
            id_temp_table,
            rfid_tag_number, 
            reader_angle,
            room_id: room_id_scan,
            room_name,
            reader_gate,
            is_legal_moving,
            waktu
        } = row;

        try {
            // Get last location data
            const dataLastLocation = await tagProcessModel.getLastLocation(rfid_tag_number);

            if (dataLastLocation) {

                // Extract data from last location
                const {
                    kode_aset: kode_aset,
                    nup: nup,
                    kode_tid: tagCode,
                    nama_aset: nama_aset,
                    lokasi_moving: lokasi_terakhir,
                    status: posisi_aset,
                    lokasi_terakhir: lokasi_terakhir_id,
                    nama_lokasi_terakhir,
                    borrow
                } = dataLastLocation;

                // let kategori_pergerakan = '';
                // let keterangan_pergerakan = '';
                const output = reader_angle === 'in' ? flag_moving_in : flag_moving_out;

                // Check if moving in same room
                if (room_id_scan == lokasi_terakhir_id) {

                    if (reader_angle == 'in') {

                        if (posisi_aset == flag_moving_in) {
                            kategori_pergerakan = 'normal';
                            keterangan_pergerakan = 'normal';
                        } else if (posisi_aset == flag_moving_out) {
                            kategori_pergerakan = 'normal';
                            keterangan_pergerakan = 'normal!';
                        }

                    } else { // reader_angle == 'out'

                        if (posisi_aset == flag_moving_in) {
                            kategori_pergerakan = 'normal';
                            keterangan_pergerakan = 'normal!';
                        } else {
                            kategori_pergerakan = 'normal';
                            keterangan_pergerakan = 'terbaca oleh reader bagian luar, lokasi terakhir masih keluar di ruangan yang sama';
                        }

                    }

                } else { // moving different room

                    if (reader_angle == 'out') {

                        if (posisi_aset == flag_moving_in) {
                            kategori_pergerakan = 'anomali';
                            keterangan_pergerakan = 'moving beda ruangan, tapi tidak terbaca oleh reader bagian luar pada ruangan sebelumnya';
                        } else { // posisi aset terakhir sedang di luar
                            kategori_pergerakan = 'normal';
                            keterangan_pergerakan = 'moving beda ruangan';
                        }

                    } else if (reader_angle == 'in') {

                        // jika posisi aset terakhir sedang di dalam
                        if (posisi_aset == flag_moving_in) {
                            kategori_pergerakan = 'anomali';
                            keterangan_pergerakan = 'moving beda ruangan, tidak terbaca oleh reader bagian luar';
                        } else { // posisi aset terakhir sedang di luar
                            // berarti dia sudah checkout, di ruangan sebelumnya. tapi dia tidak checkout di ruangan saat ini
                            kategori_pergerakan = 'normal';
                            keterangan_pergerakan = 'moving beda ruangan';
                        }

                    }
                }

                // Update status
                const updateResult = await tagProcessModel.updateStatus(
                    id_temp_table,
                    rfid_tag_number,
                    output,
                    room_id_scan,
                    row.reader_id,
                    kategori_pergerakan,
                    keterangan_pergerakan,
                    room_id_scan,
                    room_name,
                    is_legal_moving,
                    borrow,
                    waktu
                );

                console.log('id:', id_temp_table, 
                    'waktu:', new Date(waktu).toISOString().slice(0, 19).replace('T', ' '),
                    // 'tanggal:', new Date(waktu).toISOString().slice(0, 10).replace(/-/g, '-'),
                    'room_id_scan', room_id_scan,
                    'nama_aset:', nama_aset,
                    'rfid_tag_number:', rfid_tag_number, 
                    'output:', output, 
                    'room_name:', room_name, 
                    'reader_gate', reader_gate
                );

                // Prepare data for WebSocket broadcast
                const broadcastPayload = {
                    event: 'assetUpdate', 
                    data: {
                        room_name,
                        reader_gate,
                        rfid_tag_number,
                        nama_aset,
                        kode_aset,
                        nup,
                        reader_angle,
                        new_status: reader_angle,
                        kategori_pergerakan,
                        keterangan_pergerakan,
                        timestamp: new Date(waktu).toISOString().slice(0, 19).replace('T', ' ')
                        // affectedRows: updateResult.affectedRows
                    }
                };

                // Broadcast the update to all connected clients
                broadcastData(broadcastPayload);

            }

        } catch (error) {
            console.error(`Error processing tag ${rfid_tag_number}:`, error);
        }

    } 

  } catch (error) {
    console.error('Error in processTagData:', error);
  }

}

// Check for interval changes periodically
async function watchConfigChanges() {
  setInterval(async () => {
    const newInterval = await tagProcessModel.getIntervalConfig();
    if (processInterval._idleTimeout !== newInterval) {
      console.log('Interval configuration changed, updating...');
      await initializeProcessInterval();
    }
  }, 30000); // Check every 30 seconds
}

// Initialize the service
async function initializeService() {
  try {
    // Start initial interval
    await initializeProcessInterval();
    
    // Start watching for config changes
    watchConfigChanges();
    
    console.log('Service started successfully');
  } catch (error) {
    console.error('Error initializing service:', error);
    process.exit(1);
  }
}

// Error handling for process
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (error) => {
  console.error('Unhandled Rejection:', error);
});

// Start the service
initializeService();
