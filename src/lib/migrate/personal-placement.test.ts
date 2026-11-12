// @vitest-environment node
import {it,expect} from 'vitest'
import {planPersonalProject} from './personal-placement'
import {personalOrgLegacyUuidFor,orgLegacyUuidFor} from './ids'
const source={id:164,name:'Old project',namespace:'old-name',namespaceId:473,namespaceKind:'user',ownerGitlabId:197}
const directory={users:[{id:10},{id:20}],identityLinks:[{gitlabUserId:197,userId:10},{gitlabUserId:200,userId:20}]}
const maps={orgMap:new Map([[personalOrgLegacyUuidFor(473),{id:7,ownerUserId:10}]])}
it('keeps identities stable across project and owner renames and scopes collaborators to their project',()=>{
 const a=planPersonalProject(source,[{id:200,access_level:30}],directory,maps)
 const b=planPersonalProject({...source,name:'Renamed',namespace:'renamed-owner'},[{id:200,access_level:30}],directory,maps)
 expect(b.projectId).toBe(a.projectId);expect(b.orgLegacyUuid).toBe(a.orgLegacyUuid)
 expect(a.placementReady).toBe(true);expect(a.projectMembers).toEqual([{userId:20,roleLevel:400}])
 expect(a.ownerMembership).toEqual({userId:10,roleLevel:700})
 expect(planPersonalProject({...source,id:165},[],directory,maps).projectMembers).toEqual([])
 expect(a.orgLegacyUuid).not.toBe(orgLegacyUuidFor(473))
})
it('blocks absent or ambiguous identities and wrong destination owner',()=>{
 expect(planPersonalProject(source,[],{users:directory.users},maps).blockers).toContain('identity-links-endpoint-unavailable')
 expect(planPersonalProject(source,[],{...directory,identityLinks:[...directory.identityLinks,{gitlabUserId:197,userId:20}]},maps).blockers).toContain('user-identity-unresolved:197')
 expect(planPersonalProject(source,[],directory,{orgMap:new Map([[personalOrgLegacyUuidFor(473),{id:7,ownerUserId:20}]])}).blockers).toContain('destination-owner-mismatch')
})
it('does not reuse an arbitrary organization or infer an owner from a namespace name',()=>{
 expect(planPersonalProject(source,[],directory,{orgMap:new Map([[orgLegacyUuidFor(473),{id:7,ownerUserId:10}]])}).orgId).toBe(null)
 expect(()=>planPersonalProject({...source,ownerGitlabId:undefined},[],directory,maps)).toThrow('stable')
})
it('excludes expired grants and blocks permanent conversion of future-expiring grants',()=>{
 expect(planPersonalProject(source,[{id:200,access_level:40,expires_at:'2026-01-01'}],directory,maps,new Date('2026-09-24')).projectMembers).toEqual([])
 expect(planPersonalProject(source,[{id:200,access_level:40,expires_at:'2027-01-01'}],directory,maps,new Date('2026-09-24')).blockers).toContain('expiring-membership-needs-reconciliation:200')
})

it('blocks a merged owner identity even when the other source account is not a project member',()=>{
 const merged={...directory,identityLinks:[...directory.identityLinks,{gitlabUserId:201,userId:10}]}
 const plan=planPersonalProject(source,[],merged,maps)
 expect(plan.placementReady).toBe(false)
 expect(plan.ownerUserId).toBe(null)
 expect(plan.blockers).toContain('source-users-share-destination-identity:197')
})
it('blocks a merged collaborator identity without rejecting duplicate rows for the same identity',()=>{
 const merged={...directory,identityLinks:[...directory.identityLinks,{gitlabUserId:201,userId:20}]}
 const plan=planPersonalProject(source,[{id:200,access_level:30}],merged,maps)
 expect(plan.placementReady).toBe(false)
 expect(plan.projectMembers).toEqual([])
 expect(plan.blockers).toContain('source-users-share-destination-identity:200')
 expect(planPersonalProject(source,[],{...directory,identityLinks:[...directory.identityLinks,directory.identityLinks[0]]},maps).placementReady).toBe(true)
})
