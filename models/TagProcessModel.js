// models/TagProcessModel.js
const mysql = require('mysql2/promise');

class TagProcessModel {
  constructor(pool) {
    this.pool = pool;
    this.moment = require('moment-timezone');
    this.moment.tz.setDefault('Asia/Jakarta');
  }

  async getPengaturanSistem() {
    let connection;
    try {
      connection = await this.pool.getConnection();
      const [rows] = await connection.query('SELECT * FROM pengaturan_sistem LIMIT 1');
      return rows[0];
    } catch (error) {
      console.error('Error getting pengaturan sistem:', error);
      throw error;
    } finally {
      if (connection) {
        connection.release();
      }
    }
  }

  async getIntervalConfig() {
    let connection;
    try {
      connection = await this.pool.getConnection();
      const [rows] = await connection.query(
        'SELECT value FROM config WHERE id_config = 1'
      );

      if (rows.length > 0) {
        return parseInt(rows[0].value);
      }
      return 5000; // Default to 5 seconds
    } catch (error) {
      console.error('Error getting interval config:', error);
      return 5000;
    } finally {
      if (connection) {
        connection.release();
      }
    }
  }

  async getTempTableData() {
    let connection;
    try {
      connection = await this.pool.getConnection();
      const [rows] = await connection.query('SELECT * FROM tag_temp_table_process WHERE output = 0 ORDER BY id_temp_table ASC');
      return rows;
    } catch (error) {
      console.error('Error getting temp table data:', error);
      throw error;
    } finally {
      if (connection) {
        connection.release();
      }
    }
  }

  async getLastLocation(rfid_tag_number) {
    let connection;
    try {
      connection = await this.pool.getConnection();
      const [rows] = await connection.query(
        'SELECT * FROM tb_master_aset WHERE kode_tid = ?',
        [rfid_tag_number]
      );
      return rows.length > 0 ? rows[0] : null;
    } catch (error) {
      console.error('Error getting last location:', error);
      throw error;
    } finally {
      if (connection) {
        connection.release();
      }
    }
  }

  async updateStatus(id_temp_table, rfid_tag_number, output, room_id, reader_id, kategori_pergerakan, keterangan_pergerakan, lokasi_terakhir, nama_lokasi_terakhir, is_legal_moving, borrow, waktu) {

    let connection;

    try {
      connection = await this.pool.getConnection();

      // Get system settings
      const pengaturanSistem = await this.getPengaturanSistem();
      const flag_moving_in = pengaturanSistem.flag_moving_in;
      const flag_moving_out = pengaturanSistem.flag_moving_out;
      const moving_mode = pengaturanSistem.moving_mode;

      // Set status variables
      const status_id = output;
      const room_id_asset = (output == flag_moving_in) ? room_id : 0;

      // untuk insert ke moving
      const output_text = (output == flag_moving_in) ? 'In' : 'Out';
      var room_id_asset_moving = (status_id == flag_moving_in) ? room_id : 0;

      // 1. Update temp table
      await connection.query(
        `UPDATE tag_temp_table_process 
         SET output = ?,
             rfid_tag_number = ?,
             kategori_pergerakan = ?,
             keterangan_pergerakan = ?,
             lokasi_terakhir_id = ?,
             nama_lokasi_terakhir = ?
         WHERE id_temp_table = ?`,
        [
          status_id,
          rfid_tag_number,
          kategori_pergerakan,
          keterangan_pergerakan,
          lokasi_terakhir,
          nama_lokasi_terakhir,
          id_temp_table
        ]
      );

      // 2. Prepare asset master data
      let data_asset_master;

      if (output_text === 'In') {

        if (borrow == 1) {

          data_asset_master = {
            lokasi_terakhir: lokasi_terakhir,
            nama_lokasi_terakhir: nama_lokasi_terakhir,
            // tipe_moving: is_legal_moving
          };

        } else if (borrow == 2) {

          data_asset_master = {
            lokasi_terakhir: lokasi_terakhir,
            nama_lokasi_terakhir: nama_lokasi_terakhir,
            status: status_id
          };

        }
        else {

          data_asset_master = {
            status: status_id,
            lokasi_moving: room_id_asset,
            lokasi_terakhir: lokasi_terakhir,
            nama_lokasi_terakhir: nama_lokasi_terakhir,
            // tipe_moving: is_legal_moving
          };

        }

      } else { // if (output_text === 'Out')

        if (borrow == 1) {

          data_asset_master = {
            lokasi_terakhir: lokasi_terakhir,
            nama_lokasi_terakhir: nama_lokasi_terakhir,
            // tipe_moving: is_legal_moving
          };

        } else if (borrow == 2) {

          data_asset_master = {
            lokasi_terakhir: lokasi_terakhir,
            nama_lokasi_terakhir: nama_lokasi_terakhir,
            status: status_id
          };

        }
        else {

          // moving_mode = license / free. if license abaikan saja, if free, wajib di update tipe_movingnya jadi 1

          var update_tipe_moving = 0; // 0 = ilegal, 1 legal

          if (moving_mode == 'free') {

            if (is_legal_moving == 1) {
              update_tipe_moving = 1;
            } else {
              update_tipe_moving = 0;
            }

            data_asset_master = {
              status: status_id,
              lokasi_terakhir: lokasi_terakhir,
              nama_lokasi_terakhir: nama_lokasi_terakhir,
              // tipe_moving: is_legal_moving
              tipe_moving: update_tipe_moving
            };

          } else { // license

            data_asset_master = {
              status: status_id,
              lokasi_terakhir: lokasi_terakhir,
              nama_lokasi_terakhir: nama_lokasi_terakhir,
              // tipe_moving: is_legal_moving
            };

          }

        }

      }

      // 3. Delete processed temp records
      await connection.query('DELETE FROM tag_temp_table_process WHERE output != 0');

      // 4. Update master asset
      await connection.query(
        'UPDATE tb_master_aset SET ? WHERE kode_tid = ?',
        [data_asset_master, rfid_tag_number]
      );

      // 5. Insert to asset moving history
      const waktu = this.moment().format('YYYY-MM-DD HH:mm:ss');
      const tanggal = this.moment().toDate();

      const moving_data = {
        tanggal: tanggal,
        waktu: waktu,
        reader_id: reader_id,
        room_id: room_id_asset_moving,
        tag_code: rfid_tag_number,
        status_moving: output_text,
        lokasi_terakhir_id: lokasi_terakhir,
        lokasi_terakhir: nama_lokasi_terakhir
      };

      await connection.query(
        'INSERT INTO tb_asset_moving SET ?',
        [moving_data]
      );

      console.log(moving_data);

      return { success: true };

    } catch (error) {
      console.error('Error in updateStatus:', error);
      throw error;
    } finally {
      if (connection) {
        connection.release();
      }
    }
  }

}

module.exports = TagProcessModel;
