import {ensureProjectLaneStmts} from '../../../db/shared/lanes'
import {isAuthorizedAdminBearer} from '../lib/admin-auth'
import {planPersonalProject,type PersonalSource,type SourceMember} from '../../../src/lib/migrate/personal-placement'
import type {MigrateProjectEnv} from './migrate-project-route'

/** Trusted, atomic provisioning. No username matching and no shared-org fallback. */
export async function handleMigratePersonalProjectRequest(request:Request,env:MigrateProjectEnv):Promise<Response|null>{
 if(new URL(request.url).pathname!=='/migrate/personal-project')return null
 if(request.method!=='POST')return new Response('method not allowed',{status:405})
 if(!env.SYNC_SECRET_KEY||!isAuthorizedAdminBearer(request.headers.get('Authorization')??'',env))return new Response('unauthorized',{status:401})
 if(!env.AQUILLA_PG?.transaction)return Response.json({error:'Transactional personal provisioning unavailable'},{status:503})
 let body:{source:PersonalSource;members:SourceMember[]}
 try{body=await request.json();if(!body?.source||typeof body.source.name!=='string'||typeof body.source.namespace!=='string'||!Array.isArray(body.members))throw Error('Invalid body')}
 catch{return Response.json({error:'Expected source and members'},{status:400})}
 try{return await env.AQUILLA_PG.transaction(async db=>{
  await db.prepare('SELECT pg_advisory_xact_lock(hashtext(?))').bind(`personal-namespace:${body.source.namespaceId}`).first()
  const users=(await db.prepare('SELECT id FROM users').all<{id:number}>()).results.map(u=>({id:Number(u.id)}))
  const identityLinks=(await db.prepare("SELECT DISTINCT gitlab_user_id, neon_user_id FROM legacy_identity_links WHERE source='frontier-db-v2' AND gitlab_user_id IS NOT NULL").all<{gitlab_user_id:number;neon_user_id:number}>()).results.map(l=>({gitlabUserId:Number(l.gitlab_user_id),userId:Number(l.neon_user_id)}))
  const orgs=(await db.prepare('SELECT id,legacy_uuid,owner_user_id FROM organizations WHERE legacy_uuid IS NOT NULL').all<{id:number;legacy_uuid:string;owner_user_id:number}>()).results
  const plan=planPersonalProject(body.source,body.members,{users,identityLinks},{orgMap:new Map(orgs.map(o=>[o.legacy_uuid,{id:Number(o.id),ownerUserId:Number(o.owner_user_id)}]))})
  const blockers=plan.blockers.filter(b=>b!=='personal-workspace-needs-provisioning')
  if(blockers.length)throw Error(blockers.join(', '))
  await db.prepare('SELECT pg_advisory_xact_lock(hashtext(?))').bind(plan.projectId).first()
  const existing=await db.prepare('SELECT org_id,archived_at FROM projects WHERE id=? FOR UPDATE').bind(plan.projectId).first<{org_id:number;archived_at:string|null}>()
  if(existing&&(plan.orgId===null||Number(existing.org_id)!==plan.orgId||existing.archived_at!==null))throw Error('Existing project placement conflicts or project is archived')
  const expectedMembers=new Set(plan.projectMembers.map(m=>m.userId))
  const existingMembers=(await db.prepare('SELECT user_id FROM project_members WHERE project_id=? FOR UPDATE').bind(plan.projectId).all<{user_id:number}>()).results
  if(existingMembers.some(m=>!expectedMembers.has(Number(m.user_id))))throw Error('Existing project has grants absent from source; reconcile explicitly')
  for(const member of plan.projectMembers){
   const prior=await db.prepare('SELECT role_level FROM project_members WHERE project_id=? AND user_id=? FOR UPDATE').bind(plan.projectId,member.userId).first<{role_level:number}>()
   if(prior&&Number(prior.role_level)!==member.roleLevel)throw Error(`Existing project permission differs for user ${member.userId}; reconcile explicitly`)
  }
  await db.prepare('INSERT INTO organizations(name,owner_user_id,legacy_uuid) VALUES(?,?,?) ON CONFLICT(legacy_uuid) DO NOTHING').bind(plan.proposedOrganization.name,plan.ownerUserId,plan.orgLegacyUuid).run()
  const org=await db.prepare('SELECT id,owner_user_id FROM organizations WHERE legacy_uuid=? FOR UPDATE').bind(plan.orgLegacyUuid).first<{id:number;owner_user_id:number}>()
  if(!org||Number(org.owner_user_id)!==plan.ownerUserId)throw Error('Personal workspace owner mismatch')
  const ownerMember=await db.prepare('SELECT role_level FROM org_members WHERE org_id=? AND user_id=? FOR UPDATE').bind(org.id,plan.ownerUserId).first<{role_level:number}>()
  if(ownerMember&&Number(ownerMember.role_level)!==700)throw Error('Existing owner membership differs; reconcile explicitly')
  await db.prepare('INSERT INTO org_members(org_id,user_id,role_level,granted_by) VALUES(?,?,700,?) ON CONFLICT DO NOTHING').bind(org.id,plan.ownerUserId,plan.ownerUserId).run()
  await db.prepare('INSERT INTO projects(id,name,org_id,created_by,created_at,updated_at) VALUES(?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) ON CONFLICT(id) DO NOTHING').bind(plan.projectId,body.source.name,org.id,plan.ownerUserId).run()
  for(const member of plan.projectMembers)await db.prepare('INSERT INTO project_members(project_id,user_id,role_level,granted_by) VALUES(?,?,?,?) ON CONFLICT DO NOTHING').bind(plan.projectId,member.userId,member.roleLevel,plan.ownerUserId).run()
  for (const statement of ensureProjectLaneStmts(db, plan.projectId)) await statement.run()
  return Response.json({safetyVersion:1,projectId:plan.projectId,orgId:Number(org.id),ownerUserId:plan.ownerUserId,teamId:null})
 })}catch(e){return Response.json({error:String(e)},{status:409})}
}
