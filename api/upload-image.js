import { randomUUID } from 'node:crypto';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { isAuthenticated } from '../lib/session.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!isAuthenticated(req)) return res.status(401).json({error:'Unauthorized'});
  if (req.method !== 'POST') return res.status(405).json({error:'Method not allowed'});
  const {AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION, AWS_ENDPOINT_URL_S3, STORAGE_BUCKET} = process.env;
  if (![AWS_ACCESS_KEY_ID,AWS_SECRET_ACCESS_KEY,AWS_REGION,AWS_ENDPOINT_URL_S3,STORAGE_BUCKET].every(Boolean))
    return res.status(503).json({error:'Storage 환경변수를 확인해 주세요.'});
  const {image, mimeType} = req.body || {};
  if (typeof image !== 'string' || !['image/png','image/jpeg','image/webp'].includes(mimeType))
    return res.status(400).json({error:'PNG, JPG, WEBP 이미지만 업로드 가능합니다.'});
  // 2 MiB decoded; base64 sends ~2.8 MiB in a JSON request.
  if (image.length > 2800000 || !/^[a-zA-Z0-9+/]*={0,2}$/.test(image))
    return res.status(413).json({error:'이미지는 2MB 이하로 선택해 주세요.'});
  const data = Buffer.from(image,'base64');
  if (!data.length || data.length > 2*1024*1024)
    return res.status(413).json({error:'이미지는 2MB 이하로 선택해 주세요.'});
  const png = data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  const jpg = data[0]===0xff && data[1]===0xd8 && data[2]===0xff;
  const webp = data.toString('ascii',0,4)==='RIFF' && data.toString('ascii',8,12)==='WEBP';
  if (!(mimeType==='image/png'&&png || mimeType==='image/jpeg'&&jpg || mimeType==='image/webp'&&webp))
    return res.status(400).json({error:'이미지 파일 형식이 일치하지 않습니다.'});
  try {
    const endpoint = new URL(AWS_ENDPOINT_URL_S3);
    if (endpoint.protocol !== 'https:') throw new Error('Invalid S3 endpoint scheme');
    const s3 = new S3Client({
      region:AWS_REGION, endpoint:endpoint.toString(), forcePathStyle:true,
      credentials:{accessKeyId:AWS_ACCESS_KEY_ID,secretAccessKey:AWS_SECRET_ACCESS_KEY}
    });
    const extension = mimeType==='image/png'?'png':mimeType==='image/jpeg'?'jpg':'webp';
    const key = 'gemini-input/' + new Date().toISOString().slice(0,10) + '/' + randomUUID()+'.'+extension;
    await s3.send(new PutObjectCommand({Bucket:STORAGE_BUCKET,Key:key,Body:data,ContentType:mimeType}));
    return res.status(200).json({status:'ok',bucket:STORAGE_BUCKET,key,size:data.length});
  } catch(error) {
    console.error('Storage upload failed:',error?.name,error?.message);
    return res.status(502).json({error:'Storage 업로드 실패. 연결값과 버킷을 확인하세요.'});
  }
}
