import {personalOrgLegacyUuidFor,projectIdFor} from './ids'
import {mapTopLevelAccess} from './groups'

export interface PersonalSource {
 id:number; name:string; namespace:string; namespaceId?:number; namespaceKind?:string; ownerGitlabId?:number
}
export interface IdentityDirectory { users:{id:number}[]; identityLinks?:{gitlabUserId:number;userId:number}[] }
export interface SourceMember { id:number; access_level:number; expires_at?:string|null }
export interface PersonalTargets {orgMap:Map<string,{id:number;ownerUserId:number}>}
const positive=(n:unknown):n is number=>Number.isSafeInteger(n)&&Number(n)>0

/** Source ownership is explicit. Names are labels, never identity evidence.
 * The resulting collaborator grants are project scoped, never org membership.
 * This is a proposal, not permission to write or a successful migration checkpoint.
 */
export function planPersonalProject(source:PersonalSource,members:SourceMember[],directory:IdentityDirectory,targets:PersonalTargets,now=new Date()){
 const blockers:string[]=[]
 if(source.namespaceKind!=='user'||!positive(source.id)||!positive(source.namespaceId)||!positive(source.ownerGitlabId))throw Error('Personal project requires stable project, namespace and owner IDs')
 const known=new Set(directory.users.map(u=>u.id)),links=new Map<number,Set<number>>(),reverseLinks=new Map<number,Set<number>>()
 for(const link of directory.identityLinks??[]){
  if(!positive(link.gitlabUserId)||!positive(link.userId)||!known.has(link.userId))throw Error('Invalid stable user identity link')
  const set=links.get(link.gitlabUserId)??new Set<number>();set.add(link.userId);links.set(link.gitlabUserId,set)
  const sources=reverseLinks.get(link.userId)??new Set<number>();sources.add(link.gitlabUserId);reverseLinks.set(link.userId,sources)
 }
 if(!Array.isArray(directory.identityLinks))blockers.push('identity-links-endpoint-unavailable')
 const resolve=(id:number)=>{const set=links.get(id);if(set?.size!==1){blockers.push(`user-identity-unresolved:${id}`);return null}const userId=[...set][0];if(reverseLinks.get(userId)?.size!==1){blockers.push(`source-users-share-destination-identity:${id}`);return null}return userId}
 const ownerUserId=resolve(source.ownerGitlabId)
 const orgLegacyUuid=personalOrgLegacyUuidFor(source.namespaceId)
 const target=targets.orgMap.get(orgLegacyUuid)
 if(target&&ownerUserId!==null&&target.ownerUserId!==ownerUserId)blockers.push('destination-owner-mismatch')
 if(!target)blockers.push('personal-workspace-needs-provisioning')
 const projectMembers:{userId:number;roleLevel:number}[]=[],seen=new Set<number>()
 for(const member of members){
  if(!positive(member.id)||![10,20,30,40,50].includes(member.access_level))throw Error('Unsupported GitLab project membership')
  if(member.expires_at){
   if(!/^\d{4}-\d{2}-\d{2}$/.test(member.expires_at)||!Number.isFinite(Date.parse(member.expires_at))||new Date(member.expires_at).toISOString().slice(0,10)!==member.expires_at)throw Error('Invalid membership expiry')
   if(member.expires_at<now.toISOString().slice(0,10))continue
   // Aquilla grants have no source-expiry lifecycle yet. Do not turn a temporary grant into a permanent one.
   blockers.push(`expiring-membership-needs-reconciliation:${member.id}`)
  }
  if(seen.has(member.id))throw Error('Duplicate GitLab project member')
  seen.add(member.id)
  if(member.id===source.ownerGitlabId)continue
  const userId=resolve(member.id)
  if(userId!==null)projectMembers.push({userId,roleLevel:mapTopLevelAccess(member.access_level)})
 }
 if(new Set(projectMembers.map(m=>m.userId)).size!==projectMembers.length||projectMembers.some(m=>m.userId===ownerUserId))blockers.push('source-users-share-destination-identity')
 return {source,projectId:projectIdFor(String(source.id),'gitlab'),orgLegacyUuid,orgId:target?.id??null,ownerUserId,
  proposedOrganization:{legacyUuid:orgLegacyUuid,name:`${source.namespace} — Codex personal projects`,ownerUserId},
  ownerMembership:ownerUserId===null?null:{userId:ownerUserId,roleLevel:700},projectMembers,
  blockers:[...new Set(blockers)],placementReady:!!target&&ownerUserId!==null&&!blockers.length}
}
