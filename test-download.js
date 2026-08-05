import fs from 'fs';
import { pipeline } from 'stream/promises';

async function run() {
  console.log('Fetching extract...');
  const res = await fetch('http://localhost:4000/api/extract', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw', mode: 'auto', quality: '1080' })
  });
  
  if (!res.ok) throw new Error('extract failed ' + res.status);
  
  const data = await res.json();
  console.log('Extract response:', data);

  if (data.status === 'tunnel') {
    console.log('Fetching tunnel URL:', data.url);
    const memBefore = process.memoryUsage().rss / 1024 / 1024;
    
    const tunnelRes = await fetch(data.url);
    if (!tunnelRes.ok) throw new Error('tunnel failed ' + tunnelRes.status);
    
    console.log('Piping to file...');
    const out = fs.createWriteStream('test_video.mp4');
    
    const { Readable } = await import('stream');
    await pipeline(Readable.fromWeb(tunnelRes.body), out);
    
    const memAfter = process.memoryUsage().rss / 1024 / 1024;
    console.log('Done. Mem before (MB):', memBefore.toFixed(2), 'Mem after (MB):', memAfter.toFixed(2));
  } else if (data.url) {
    console.log('Direct url returned, no tunnel. URL:', data.url);
  }
}

run().catch(console.error);
