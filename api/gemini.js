import { isAuthenticated } from '../lib/session.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!isAuthenticated(req)) return res.status(401).json({error:'Unauthorized'});
  if (req.method !== 'POST') return res.status(405).json({error:'Method not allowed'});
  const question = req.body?.question;
  if (typeof question !== 'string' || !question.trim() || question.length > 2000)
    return res.status(400).json({error:'질문은 1~2000자로 입력하세요.'});
  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(503).json({error:'GEMINI_API_KEY 환경변수가 필요합니다.'});
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  if (!/^gemini-[a-z0-9.-]+$/.test(model)) return res.status(503).json({error:'잘못된 모델 설정'});
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);
  try {
    const response = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' +
      model + ':generateContent', {
      method: 'POST',
      headers: {'Content-Type':'application/json', 'x-goog-api-key':key},
      body: JSON.stringify({
        systemInstruction: {parts:[{text:'한국어로 간결하고 정확하게 답하세요. 기본 2~4문장, 필요한 경우에만 추가 설명을 합니다.'}]},
        contents:[{role:'user',parts:[{text:question.trim()}]}],
        generationConfig:{maxOutputTokens:512,temperature:0.3}
      }),
      signal: controller.signal
    });
    const payload = await response.json();
    if (!response.ok) {
      console.error('Gemini request failed', response.status, payload?.error?.status);
      return res.status(response.status === 429 ? 429 : 502).json({
        error: response.status === 429 ? 'Gemini 요청 한도 초과입니다.' : 'Gemini 응답 오류입니다.'
      });
    }
    const answer = (payload?.candidates?.[0]?.content?.parts || [])
      .filter(p => typeof p.text === 'string').map(p => p.text).join('').trim();
    if (!answer) return res.status(502).json({error:'Gemini가 텍스트 답변을 반환하지 않았습니다.'});
    return res.status(200).json({status:'ok',answer});
  } catch (e) {
    console.error('Gemini network error',e?.name);
    return res.status(504).json({error:'Gemini 요청 시간 초과 또는 네트워크 오류'});
  } finally { clearTimeout(timeout); }
}
