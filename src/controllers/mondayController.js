const axios = require('axios');
const http = require('http');
const https = require('https');

class MondayController {
  constructor() {
    this.apiUrl = process.env.MONDAY_API_URL || 'https://api.monday.com/v2';
    this.apiToken = process.env.MONDAY_API_TOKEN;
    this.defaultBoardId = '1443407769';
    this.fileColumnId = 'arquivos';

    // Simple in-memory cache for asset URLs (TTL: 1 hour)
    this.assetUrlCache = new Map();
    this.CACHE_TTL = 60 * 60 * 1000; // 1 hour

    // Create axios instance with connection pooling
    this.axiosInstance = axios.create({
      baseURL: this.apiUrl,
      timeout: 30000,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      httpAgent: new http.Agent({ keepAlive: true, maxSockets: 10 }),
      httpsAgent: new https.Agent({ keepAlive: true, maxSockets: 10 }),
      headers: {
        'Authorization': this.apiToken,
        'Content-Type': 'application/json',
        'API-Version': '2024-01'
      }
    });
  }

  /**
   * Execute GraphQL query to Monday.com API
   */
  async executeQuery(query, variables = {}, retries = 3) {
    try {
      const response = await this.axiosInstance.post('', { query, variables });

      if (response.data.errors) {
        throw new Error(JSON.stringify(response.data.errors));
      }

      return response.data.data;
    } catch (error) {
      // Retry on connection errors
      if (retries > 0 && (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED')) {
        console.log(`⚠️ Connection error (${error.code}), retrying... (${retries} attempts left)`);
        await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second before retry
        return this.executeQuery(query, variables, retries - 1);
      }

      console.error('Monday API Error:', error.message);
      throw error;
    }
  }

  /**
   * Update Monday.com board item with extracted data
   */
  async updateMondayBoard(boardId, itemId, extractedData) {
    // Map extracted data to Monday columns
    const columnValues = this.mapDataToColumns(extractedData);

    const query = `
      mutation ($boardId: ID!, $itemId: ID!, $columnValues: JSON!) {
        change_multiple_column_values(
          board_id: $boardId,
          item_id: $itemId,
          column_values: $columnValues
        ) {
          id
        }
      }
    `;

    const variables = {
      boardId: boardId.toString(),
      itemId: itemId.toString(),
      columnValues: JSON.stringify(columnValues)
    };

    const result = await this.executeQuery(query, variables);
    console.log(`  💾 Monday.com updated`);

    return result;
  }

  /**
   * Create a new item on Monday.com board with extracted data
   */
  async createMondayItem(boardId, itemName, extractedData) {
    const columnValues = this.mapDataToColumns(extractedData);

    const query = `
      mutation ($boardId: ID!, $itemName: String!, $columnValues: JSON!) {
        create_item(
          board_id: $boardId,
          item_name: $itemName,
          column_values: $columnValues
        ) {
          id
          name
          column_values {
            id
            text
            value
          }
        }
      }
    `;

    const variables = {
      boardId: boardId.toString(),
      itemName: itemName,
      columnValues: JSON.stringify(columnValues)
    };

    return await this.executeQuery(query, variables);
  }

  /**
   * Get board columns information
   */
  async getBoardColumns(boardId) {
    const query = `
      query ($boardId: [ID!]) {
        boards(ids: $boardId) {
          columns {
            id
            title
            type
            settings_str
          }
        }
      }
    `;

    const variables = {
      boardId: [boardId.toString()]
    };

    const result = await this.executeQuery(query, variables);
    return result.boards[0].columns;
  }

  /**
   * Map extracted data to Monday.com column format
   * Configured for invoice processing
   */
  mapDataToColumns(extractedData) {
    const columnValues = {};

    // I8 → numeric_mkwbrpmz (Total with tax)
    if (extractedData.totalValue !== null && extractedData.totalValue !== undefined) {
      columnValues['numeric_mkwbrpmz'] = extractedData.totalValue;
    }

    // G → text_mkwb4nns (Invoice number)
    if (extractedData.invoiceNumber) {
      columnValues['text_mkwb4nns'] = extractedData.invoiceNumber;
    }

    // Supplier name → text_mkwbcyg3
    if (extractedData.supplierName) {
      columnValues['text_mkwbcyg3'] = extractedData.supplierName;
    }

    // A → text_mkwbb9 (Customer NIF)
    if (extractedData.customerNIF) {
      columnValues['text_mkwbb9'] = extractedData.customerNIF;
    }

    return columnValues;
  }

  /**
   * Upload file to Monday.com
   */
  async uploadFileToMonday(itemId, columnId = null, filePath) {
    const fs = require('fs');
    const FormData = require('form-data');

    // Use default file column if not specified
    const targetColumnId = columnId || this.fileColumnId;

    const form = new FormData();
    form.append('query', `mutation ($file: File!) { add_file_to_column (item_id: ${itemId}, column_id: "${targetColumnId}", file: $file) { id } }`);
    form.append('variables[file]', fs.createReadStream(filePath));

    try {
      const response = await axios.post(this.apiUrl, form, {
        headers: {
          ...form.getHeaders(),
          'Authorization': this.apiToken
        }
      });

      return response.data;
    } catch (error) {
      console.error('File upload error:', error.message);
      throw error;
    }
  }

  /**
   * Create item and upload file in one operation
   */
  async createItemWithFile(itemName, filePath, extractedData = null) {
    // Create new item
    const item = await this.createMondayItem(
      this.defaultBoardId,
      itemName,
      extractedData || {}
    );

    // Upload file to the item
    await this.uploadFileToMonday(item.create_item.id, this.fileColumnId, filePath);

    return item;
  }

  /**
   * Get item files from the arquivos column
   */
  async getItemFiles(itemId) {
    const query = `
      query ($itemId: [ID!]) {
        items(ids: $itemId) {
          id
          name
          column_values(ids: ["arquivos"]) {
            id
            value
            text
          }
        }
      }
    `;

    const variables = {
      itemId: [itemId.toString()]
    };

    const result = await this.executeQuery(query, variables);

    if (!result.items || result.items.length === 0) {
      return null;
    }

    const item = result.items[0];
    const fileColumn = item.column_values.find(col => col.id === 'arquivos');

    if (!fileColumn || !fileColumn.value) {
      return { files: [] };
    }

    // Parse the file column value
    let fileData;
    try {
      fileData = JSON.parse(fileColumn.value);
    } catch (e) {
      console.error('Error parsing file column value:', fileColumn.value);
      return { files: [] };
    }

    const files = fileData.files || fileData.file || [];

    // Ensure files is an array
    const fileArray = Array.isArray(files) ? files : [files];

    return {
      itemId: item.id,
      itemName: item.name,
      files: fileArray.map(f => ({
        name: f.name || f.fileName || 'unknown',
        url: f.url || f.assetId || f.publicUrl || null,
        fileType: f.fileType || 'unknown'
      })).filter(f => f.url) // Only return files with valid URLs
    };
  }

  /**
   * Download a file from Monday.com
   */
  async downloadFile(fileUrl, fileName) {
    const fs = require('fs');
    const path = require('path');
    const https = require('https');
    const http = require('http');

    return new Promise(async (resolve, reject) => {
      // Check if fileUrl is valid
      if (!fileUrl) {
        return reject(new Error('File URL is undefined or empty'));
      }

      // If fileUrl is a number (asset ID), we need to get the actual URL from Monday.com
      if (typeof fileUrl === 'number') {
        console.log(`File URL is an asset ID: ${fileUrl}. Need to fetch actual URL from Monday.com API.`);
        return reject(new Error(`Asset ID provided (${fileUrl}) instead of direct URL. Monday.com file columns changed - need to use Assets API.`));
      }

      // Convert to string if needed
      const urlString = String(fileUrl);

      const filePath = path.join('uploads', Date.now() + '-' + fileName);
      const file = fs.createWriteStream(filePath);

      const protocol = urlString.startsWith('https') ? https : http;

      // Check if URL is a pre-signed S3 URL (doesn't need auth header)
      const isS3Url = urlString.includes('amazonaws.com') || urlString.includes('X-Amz-Signature');

      const headers = {
        'User-Agent': 'Mozilla/5.0'
      };

      // Only add Authorization for Monday.com direct URLs, not S3 pre-signed URLs
      if (!isS3Url) {
        headers['Authorization'] = this.apiToken;
      }

      protocol.get(urlString, { headers }, (response) => {
        // Follow redirects
        if (response.statusCode === 302 || response.statusCode === 301) {
          const redirectUrl = response.headers.location;
          const redirectProtocol = redirectUrl.startsWith('https') ? https : http;

          // Don't send auth header for S3 redirects either
          const redirectHeaders = { 'User-Agent': 'Mozilla/5.0' };

          redirectProtocol.get(redirectUrl, { headers: redirectHeaders }, (redirectResponse) => {
            redirectResponse.pipe(file);
            file.on('finish', () => {
              file.close();
              const stats = fs.statSync(filePath);
              console.log(`  ⬇️  Downloaded: ${fileName} (${(stats.size / 1024).toFixed(1)}KB)`);
              resolve(filePath);
            });
          }).on('error', reject);
        } else if (response.statusCode === 200) {
          response.pipe(file);
          file.on('finish', () => {
            file.close();
            const stats = fs.statSync(filePath);
            console.log(`  ⬇️  Downloaded: ${fileName} (${(stats.size / 1024).toFixed(1)}KB)`);
            resolve(filePath);
          });
        } else {
          file.close();
          fs.unlink(filePath, () => {});
          reject(new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`));
        }
      }).on('error', (err) => {
        fs.unlink(filePath, () => {}); // Delete the file on error
        reject(err);
      });
    });
  }

  /**
   * Get file URL from asset ID using Monday.com Assets API (with caching)
   */
  async getAssetUrl(assetId) {
    const cacheKey = String(assetId);

    // Check cache first
    const cached = this.assetUrlCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp < this.CACHE_TTL)) {
      return cached.url;
    }

    const query = `
      query ($assetIds: [ID!]!) {
        assets(ids: $assetIds) {
          id
          public_url
        }
      }
    `;

    const variables = {
      assetIds: [cacheKey]
    };

    try {
      const result = await this.executeQuery(query, variables);

      if (result.assets && result.assets.length > 0) {
        const url = result.assets[0].public_url;

        // Cache the URL
        this.assetUrlCache.set(cacheKey, { url, timestamp: Date.now() });

        return url;
      }

      throw new Error(`Asset ${assetId} not found`);
    } catch (error) {
      console.error(`Error fetching asset URL: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get all items from a board where status column is "Feito"
   */
  async getAllBoardItems(boardId) {
    const query = `
      query ($boardId: [ID!]) {
        boards(ids: $boardId) {
          items_page {
            items {
              id
              name
              column_values(ids: ["color_mkwb6j7j"]) {
                id
                text
                value
              }
            }
          }
        }
      }
    `;

    const variables = {
      boardId: [boardId.toString()]
    };

    try {
      const result = await this.executeQuery(query, variables);

      if (!result.boards || result.boards.length === 0) {
        return [];
      }

      const allItems = result.boards[0].items_page.items;

      // Filter items where status column is "Feito"
      const feitoItems = allItems.filter(item => {
        const statusColumn = item.column_values.find(col => col.id === 'color_mkwb6j7j');
        return statusColumn && statusColumn.text === 'Feito';
      });

      console.log(`Found ${feitoItems.length} items with status "Feito" out of ${allItems.length} total items`);

      return feitoItems;
    } catch (error) {
      console.error('Error fetching board items:', error);
      throw error;
    }
  }
}

module.exports = new MondayController();
