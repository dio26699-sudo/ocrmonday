require('dotenv').config();
const axios = require('axios');

const apiUrl = 'https://api.monday.com/v2';
const apiToken = process.env.MONDAY_API_TOKEN;
const boardId = '1443407769';

async function getAllItems() {
  const query = `
    query ($boardId: ID!) {
      boards(ids: [$boardId]) {
        items_page {
          items {
            id
            name
            column_values {
              id
              text
              value
              type
            }
          }
        }
      }
    }
  `;

  try {
    const response = await axios.post(
      apiUrl,
      { query, variables: { boardId } },
      {
        headers: {
          'Authorization': apiToken,
          'Content-Type': 'application/json',
          'API-Version': '2024-01'
        }
      }
    );

    if (response.data.errors) {
      console.error('GraphQL Errors:', JSON.stringify(response.data.errors, null, 2));
      return;
    }

    const items = response.data.data.boards[0].items_page.items;

    console.log(`\n📊 Found ${items.length} items in board ${boardId}\n`);

    items.forEach((item, index) => {
      console.log(`\n[${ index + 1}] Item: ${item.name} (ID: ${item.id})`);
      console.log('─'.repeat(60));

      // Find the arquivos column
      const fileColumn = item.column_values.find(col => col.id === 'arquivos');

      if (fileColumn && fileColumn.value && fileColumn.value !== '{}') {
        try {
          const fileData = JSON.parse(fileColumn.value);
          console.log('📁 Files:', JSON.stringify(fileData, null, 2));
        } catch (e) {
          console.log('📁 Files (raw):', fileColumn.value);
        }
      } else {
        console.log('📁 Files: None');
      }

      // Show other relevant columns
      const valorCol = item.column_values.find(col => col.id === 'numeric_mkwbrpmz');
      const invoiceCol = item.column_values.find(col => col.id === 'text_mkwb4nns');
      const supplierCol = item.column_values.find(col => col.id === 'text_mkwbcyg3');
      const webhookCol = item.column_values.find(col => col.id === 'color_mkwb6j7j');

      if (valorCol) console.log('💰 Valor:', valorCol.text || 'empty');
      if (invoiceCol) console.log('🔢 Invoice #:', invoiceCol.text || 'empty');
      if (supplierCol) console.log('🏢 Supplier:', supplierCol.text || 'empty');
      if (webhookCol) console.log('🔘 Webhook Status:', webhookCol.text || 'empty');
    });

    console.log('\n' + '='.repeat(60) + '\n');

  } catch (error) {
    console.error('Error:', error.message);
  }
}

getAllItems();
