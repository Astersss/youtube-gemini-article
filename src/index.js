import { extractVideoId, fetchTranscript } from './services/youtube.js';
import { streamArticle } from './services/gemini.js';
import { renderPage } from './templates/ui.js';

export default {
  async fetch(request, env) {
    const { pathname, searchParams } = new URL(request.url);

    if (pathname === '/')              return serveUI();
    if (pathname === '/api/article')   return handleArticle(searchParams, env);
    return new Response('Not Found', { status: 404 });
  },
};

function serveUI() {
  return new Response(renderPage(), {
    headers: { 'Content-Type': 'text/html; charset=UTF-8' },
  });
}

async function handleArticle(searchParams, env) {
  const youtubeUrl = searchParams.get('url');
  if (!youtubeUrl) return jsonError('Missing ?url= parameter', 400);

  const videoId = extractVideoId(youtubeUrl);
  if (!videoId)   return jsonError('Invalid YouTube URL', 400);

  // Validate and fetch transcript before opening the stream.
  // Once a streaming Response is returned, HTTP status cannot change.
  let transcriptData;
  try {
    transcriptData = await fetchTranscript(videoId);
  } catch (err) {
    return jsonError(err.message, 502);
  }

  let textStream;
  try {
    textStream = await streamArticle(transcriptData, env.GEMINI_API_KEY);
  } catch (err) {
    return jsonError(err.message, 502);
  }

  // Pipe the ReadableStream<string> through TextEncoderStream → ReadableStream<Uint8Array>
  return new Response(textStream.pipeThrough(new TextEncoderStream()), {
    headers: {
      'Content-Type':           'text/plain; charset=UTF-8',
      'Cache-Control':          'no-cache',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
