const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

app.post('/generate', async (req, res) => {
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-opus-4-5',
        max_tokens: 8000,
        messages: req.body.messages
      })
    });

    const data = await response.json();

    console.log('Anthropic status:', response.status);
    if (data.error) {
      console.error('Anthropic error:', JSON.stringify(data.error));
    }

    res.json(data);

  } catch (err) {
    console.error('Server error:', err.message);
    res.status(500).json({ error: { message: err.message } });
  }
});

app.get('/', (req, res) => {
  res.send('Brand Visable API — running');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
