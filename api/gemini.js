import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { isAuthenticated } from '../lib/session.js';

const MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite'];
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!isAuthenticated(req)) return res.status(401).json({error: 'Unauthorized'});
  if (req.method !== 'POST') return res.status(405).json({error: 'Method not allowed'});
  const question = req.body?.question;
  if (typeof question !== 'string' || !question.trim() || question.length > 4000)
    return res.status(400).json({error: '질문은 1~4000자로 입력하세요.'});

  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) return res.status(503).json({error: 'GEMINI_API_KEY 환경변수가 필요합니다. Preview를 재배포해 주세요.'});

  const parts = [{text: '너는 유용한 단발성 질의응답 도우미야. 다음 질문에 핵심만 간단히 답변해줘:\n\n' + question.trim()}];
  const inlineImage = req.body?.inlineImage;
  if (inlineImage != null) {
    const mime = inlineImage?.mimeType;
    const base64 = inlineImage?.data;
    if (!['image/png','image/jpeg','image/webp'].includes(mime) ||
        typeof base64 !== 'string' || base64.length > 2800000 ||
        !/^[a-zA-Z0-9+/]*={0,2}$/.test(base64)) {
      return res.status(400).json({error:'올바른 이미지(2MB 이하)가 필요합니다.'});
    }
    const bytes = Buffer.from(base64, 'base64');
    if (!bytes.length || bytes.length > 2*1024*1024 ||
        !(mime==='image/png' && bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ||
          mime==='image/jpeg' && bytes[0]===255 && bytes[1]===216 && bytes[2]===255 ||
          mime==='image/webp' && bytes.toString('ascii',0,4)==='RIFF' && bytes.toString('ascii',8,12)==='WEBP')) {
      return res.status(400).json({error:'이미지 형식 또는 크기 오류'});
    }
    parts.push({inline_data:{mime_type:mime,data:base64}});
  }
  const imageKey = req.body?.imageKey;
  if (imageKey != null && inlineImage == null) {
    if (typeof imageKey !== 'string' ||
        !/^gemini-input\/\d{4}-\d{2}-\d{2}\/[a-f0-9-]{36}\.(png|jpg|webp)$/.test(imageKey))
      return res.status(400).json({error: '잘못된 이미지 경로입니다.'});
    const {AWS_ACCESS_KEY_ID,AWS_SECRET_ACCESS_KEY,AWS_REGION,AWS_ENDPOINT_URL_S3,STORAGE_BUCKET} = process.env;
    if (![AWS_ACCESS_KEY_ID,AWS_SECRET_ACCESS_KEY,AWS_REGION,AWS_ENDPOINT_URL_S3,STORAGE_BUCKET].every(Boolean))
      return res.status(503).json({error: 'Storage 환경변수를 확인해 주세요.'});
    try {
      const s3 = new S3Client({
        region: AWS_REGION, endpoint: AWS_ENDPOINT_URL_S3, forcePathStyle: true,
        credentials: {accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY}
      });
      const result = await s3.send(new GetObjectCommand({Bucket: STORAGE_BUCKET, Key: imageKey}));
      if (result.ContentLength && result.ContentLength > 2*1024*1024)
        return res.status(413).json({error:'이미지는 2MB 이하만 분석합니다.'});
      const chunks = [];
      let size = 0;
      for await (const chunk of result.Body) {
        size += chunk.length;
        if (size > 2*1024*1024) return res.status(413).json({error:'이미지 크기 초과'});
        chunks.push(chunk);
      }
      const mimeType = imageKey.endsWith('.png')?'image/png':imageKey.endsWith('.jpg')?'image/jpeg':'image/webp';
      parts.push({inline_data:{mime_type:mimeType,data:Buffer.concat(chunks).toString('base64')}});
    } catch (err) {
      console.error('Gemini image retrieval failed:',err?.name);
      return res.status(502).json({error:'Neon Storage 이미지를 불러오지 못했습니다.'});
    }
  }
  const requestBody = JSON.stringify({contents:[{role:'user',parts}]});

  for (let i = 0; i < MODELS.length; i++) {
    const model = MODELS[i];
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(ENDPOINT + model + ':generateContent', {
        method: 'POST',
        headers: {'Content-Type': 'application/json', 'x-goog-api-key': key},
        body: requestBody,
        signal: controller.signal
      });
      const payload = await response.json();
      if (response.ok) {
        const answer = (payload?.candidates?.[0]?.content?.parts || [])
          .filter(p => typeof p.text === 'string')
          .map(p => p.text).join('').trim();
        if (answer) return res.status(200).json({status: 'ok', answer, model});
        if (i === 0) continue;
        return res.status(502).json({error: 'Gemini가 답변을 반환하지 않았습니다.'});
      }
      console.error('Gemini model error', model, response.status, payload?.error?.status);
      // Quota, transient service failure, or unavailable model: try Flash-Lite.
      if (i === 0 && [404, 429, 500, 502, 503, 504].includes(response.status)) continue;
      if ([401, 403].includes(response.status))
        return res.status(502).json({error: 'Gemini API 키 또는 접근 권한을 확인해 주세요.'});
      return res.status(response.status === 429 ? 429 : 502).json({
        error: response.status === 429
          ? 'Flash와 Flash-Lite 모두 요청 한도를 초과했습니다.'
          : 'Gemini 응답 오류입니다.'
      });
    } catch (e) {
      console.error('Gemini request failed', model, e?.name);
      if (i === 0) continue;
      return res.status(504).json({error: '두 Gemini 모델 모두 연결할 수 없습니다.'});
    } finally {
      clearTimeout(timeout);
    }
  }
  return res.status(502).json({error: 'Gemini 모델을 사용할 수 없습니다.'});
}
