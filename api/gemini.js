import { isAuthenticated } from '../lib/session.js';

const MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite'];
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!isAuthenticated(req)) return res.status(401).json({error: 'Unauthorized'});
  if (req.method !== 'POST') return res.status(405).json({error: 'Method not allowed'});
  const question = req.body?.question;
  if (typeof question !== 'string' || !question.trim() || question.length > 2000)
    return res.status(400).json({error: '질문은 1~2000자로 입력하세요.'});

  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) return res.status(503).json({error: 'GEMINI_API_KEY 환경변수가 필요합니다. Preview를 재배포해 주세요.'});

  const requestBody = JSON.stringify({
    systemInstruction: {parts: [{text: '한국어로 정확하고 간결하게 답하세요. 기본 2~4문장으로 답합니다.'}]},
    contents: [{role: 'user', parts: [{text: question.trim()}]}],
    generationConfig: {maxOutputTokens: 768, temperature: 0.3}
  });

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
