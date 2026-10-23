import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { isAuthenticated } from '../lib/session.js';
function client() {
 const {AWS_ACCESS_KEY_ID,AWS_SECRET_ACCESS_KEY,AWS_REGION,AWS_ENDPOINT_URL_S3,STORAGE_BUCKET}=process.env;
 if (![AWS_ACCESS_KEY_ID,AWS_SECRET_ACCESS_KEY,AWS_REGION,AWS_ENDPOINT_URL_S3,STORAGE_BUCKET].every(Boolean)) throw Error('Storage configuration missing');
 return {bucket:STORAGE_BUCKET, s3:new S3Client({region:AWS_REGION,endpoint:AWS_ENDPOINT_URL_S3,forcePathStyle:true,credentials:{accessKeyId:AWS_ACCESS_KEY_ID,secretAccessKey:AWS_SECRET_ACCESS_KEY}})};
}
export default async function handler(req,res) {
 res.setHeader('Cache-Control','no-store');
 if (!isAuthenticated(req)) return res.status(401).json({error:'Unauthorized'});
 if(req.method!=='GET') return res.status(405).json({error:'Method not allowed'});
 try {
  const {s3,bucket}=client();
  const key=req.query.key;
  if(key!==undefined) {
   if(typeof key!=='string'||!/^gemini-input\/\d{4}-\d{2}-\d{2}\/[a-f0-9-]{36}\.(png|jpg|webp)$/.test(key)) return res.status(400).json({error:'Invalid image key'});
   const url=await getSignedUrl(s3,new GetObjectCommand({Bucket:bucket,Key:key}),{expiresIn:300});
   return res.status(200).json({url,expiresIn:300});
  }
  const prefix='gemini-input/';
  const objects=await s3.send(new ListObjectsV2Command({Bucket:bucket,Prefix:prefix,MaxKeys:100}));
  const items=(objects.Contents||[]).filter(x=>x.Key && /\.(png|jpg|webp)$/.test(x.Key))
   .map(x=>({key:x.Key,size:x.Size||0,lastModified:x.LastModified?.toISOString()||null}))
   .sort((a,b)=>(b.lastModified||'').localeCompare(a.lastModified||''));
  return res.status(200).json({items,truncated:!!objects.IsTruncated});
 } catch(e) {console.error('Storage list failed',e?.name,e?.message);return res.status(502).json({error:'Storage 목록을 가져오지 못했습니다.'});}
}
