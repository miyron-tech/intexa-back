import pg from 'pg';
const email=process.argv[2]?.trim().toLowerCase();
if(!email || !email.includes('@'))throw new Error('Usage: npm run admin:grant -- existing-account@example.com');
if(!process.env.DATABASE_URL)throw new Error('DATABASE_URL is required');
const db=new pg.Client({connectionString:process.env.DATABASE_URL});
await db.connect();
try{const result=await db.query("UPDATE users SET role='admin' WHERE email=$1 RETURNING email",[email]);if(result.rowCount!==1)throw new Error('Account not found. Register it first.');console.log(`Administrator access granted to ${result.rows[0].email}`);}finally{await db.end()}
