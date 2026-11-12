import {it,expect,afterAll} from 'vitest'
import {makeTestDb,type TestDb} from './helpers/pg-test-db'
import {handleMigratePersonalProjectRequest} from '../events/migrate-personal-project-route'
import {projectIdFor} from '../../../src/lib/migrate/ids'
let t:TestDb
const source={id:164,name:'Original',namespace:'alice',namespaceId:473,namespaceKind:'user',ownerGitlabId:197,path_with_namespace:'alice/original',last_activity_at:'',http_url_to_repo:'',default_branch:'main'}
afterAll(async()=>{await t?.close()})
it('client/server provisions personal ownership and collaborator access without access to sibling projects',async()=>{
 t=await makeTestDb({users:[{id:10,username:'renamed-owner',email:'a@example.com'},{id:20,username:'collaborator',email:'b@example.com'}]})
 await t.pg.exec(`INSERT INTO legacy_identity_links(source,source_user_id,neon_user_id,source_username,source_email,gitlab_user_id,imported_via) VALUES
 ('frontier-db-v2',197,10,'alice','a@example.com',197,'jit'),('frontier-db-v2',200,20,'bob','b@example.com',200,'jit')`)
 const saved=globalThis.fetch
 globalThis.fetch=async(input,init)=>(await handleMigratePersonalProjectRequest(new Request(String(input),init),{AQUILLA_PG:t.db,SYNC_SECRET_KEY:'test'}))!
 try{
  const client={provisionPersonal:async(source:any,members:any[])=>{const response=await handleMigratePersonalProjectRequest(new Request('https://sync.test/migrate/personal-project',{method:'POST',headers:{Authorization:'Bearer test','Content-Type':'application/json'},body:JSON.stringify({source,members})}),{AQUILLA_PG:t.db,SYNC_SECRET_KEY:'test'});if(!response?.ok)throw Error(await response!.text());return response!.json() as Promise<any>}}
  const result=await client.provisionPersonal(source,[{id:200,access_level:30}])
  expect(result.ownerUserId).toBe(10)
  expect(await t.db.prepare('SELECT role_level FROM project_members WHERE project_id=? AND user_id=20').bind(projectIdFor('164','gitlab')).first()).toMatchObject({role_level:400})
  expect(await t.db.prepare('SELECT user_id FROM org_members WHERE user_id=20').first()).toBeNull()
  await client.provisionPersonal({...source,id:165,name:'Sibling'},[])
  expect(await t.db.prepare('SELECT user_id FROM project_members WHERE project_id=?').bind(projectIdFor('165','gitlab')).first()).toBeNull()
  await t.db.prepare('UPDATE projects SET name=? WHERE id=?').bind('Aquilla renamed',projectIdFor('164','gitlab')).run()
  await client.provisionPersonal({...source,name:'Codex renamed',namespace:'new-user-name'},[{id:200,access_level:30}])
  expect(await t.db.prepare('SELECT name FROM projects WHERE id=?').bind(projectIdFor('164','gitlab')).first()).toMatchObject({name:'Aquilla renamed'})
  await expect(client.provisionPersonal({...source,id:166},[{id:999,access_level:30}])).rejects.toThrow('identity-unresolved')
  expect(await t.db.prepare('SELECT id FROM projects WHERE id=?').bind(projectIdFor('166','gitlab')).first()).toBeNull()
  await expect(client.provisionPersonal(source,[{id:200,access_level:40}])).rejects.toThrow('permission differs')
  await expect(client.provisionPersonal({...source,ownerGitlabId:200},[])).rejects.toThrow('destination-owner-mismatch')
  await t.db.prepare('UPDATE projects SET archived_at=CURRENT_TIMESTAMP WHERE id=?').bind(projectIdFor('164','gitlab')).run()
  await expect(client.provisionPersonal(source,[])).rejects.toThrow('archived')
 }finally{globalThis.fetch=saved}
})
