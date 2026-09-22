import assert from"node:assert/strict";import{createHash}from"node:crypto";import{readFileSync}from"node:fs";import path from"node:path";import{plugin}from"bun";
const root=process.env["CQ_T6580_RUNTIME_ROOT"];
const source=process.env["CQ_T6580_SOURCE_ROOT"];
assert.ok(root,"CQ_T6580_RUNTIME_ROOT is required");
assert.ok(source,"CQ_T6580_SOURCE_ROOT is required");
const target=root+"/packages/ledger-mcp/test/supervisedWorkerGateStorage.test.ts";
const fixtureInput=source+"/packages/ledger-mcp/test/supervisedWorkerGateStorage.test.ts";
let contents=readFileSync(fixtureInput,"utf8");
assert.equal(createHash("sha256").update(contents).digest("hex"),"c87e29ac11305196a220872760511a6f12042c4d6da7be96d27fd24fdf1be228","unexpected R22 supervised-storage fixture input");
const pos=contents.indexOf('      const guardedTip = guardedRecord["startingCommit"];');
const start=contents.indexOf('      expect(\n        await activeCapability.abort({',pos);
const endMarker='      await reopenedBackend.close();\n      return;';
const end=contents.indexOf(endMarker,start);assert.ok(pos>=0&&start>pos&&end>start);
contents=contents.slice(0,start)+"\n      const lineage=guardedRecord[\"guardedRebaseLineage\"] as Readonly<Record<string,DispatchJSONValue>>;\n      const guardedBase=guardedRecord[\"baseCommit\"];\n      if(typeof guardedBase!==\"string\")throw Error(\"missing guarded base\");\n      expect(await activeCapability.storeResult({\n        resultCapability:guarded.prepared.resultCapability,\n        output:{...subject.output,status:\"pass\",resultCommit:guardedTip,filesTouched:[\"file.txt\"],gitReceipts:[],\n          gitLineage:{kind:\"guarded-rebase\",guardedRebase:lineage[\"guardedRebase\"],ontoCommit:lineage[\"ontoCommit\"],rebasedStartCommit:lineage[\"rebasedStartCommit\"],exactTip:lineage[\"exactTip\"]},\n          baseVerification:{status:\"verified\",relation:\"descendant\",baseCommit:guardedBase,headCommit:guardedTip}}\n      })).toMatchObject({state:\"gate-pending\"});\n      const guardedQualified=await qualify(guarded.prepared,guarded.expectedChild,\"2026-08-12T20:00:11.000Z\");\n      expect(guardedQualified.state).toBe(\"queued\");\n      if(guardedQualified.state!==\"queued\")throw Error(\"guarded successor did not qualify\");\n      expect(await activeCapability.coordinateImplementationCandidate!({partitionKey:guardedQualified.partitionKey,holderId:\"parent-consumed-guarded-before-ordinary\"})).toMatchObject({state:\"completed\"});\n      expect(runner.requests).toHaveLength(2);\n      const continuation=await activeCapability.resolveContinuation!(binding,guardedTip);\n      const ordinaryChild={childId:\"implement-worker#parent-empty-ordinary-\"+attestationBackend,runId:\"parent-empty-ordinary-\"+attestationBackend};\n      const ordinary=await activeCapability.prepare({\n        roleId:\"implement-worker\",input:{taskId:\"T2081\",headline:\"supervise exact tip\",description:\"run the full gate outside the workspace-write sandbox\",\n          acceptance:\"only a green exact tip becomes consumable\",worktreePath:subject.managed.handle.absolutePath,branch:subject.managed.handle.branch,\n          baseCommit:guardedBase,round:4,startingCommit:guardedTip,validationIntent:\"final\",priorResultCommit:guardedTip},\n        idempotencyKey:\"parent-empty-ordinary-\"+String(sequence),timeoutMs:600_000,expectedChild:ordinaryChild,continuation:continuation.continuationReference});\n      if(!ordinary.accepted)throw Error(ordinary.detail);\n      expect(await activeCapability.fetchInput({...ordinary.handle,inputCapability:ordinary.prepared.inputCapability})).toMatchObject({state:\"input-materialized\"});\n      expect(await activeCapability.abort({...ordinary.handle,reason:\"cancelled\"})).toMatchObject({state:\"aborted\",reason:\"cancelled\"});\n      console.log(\"CANCELLED_ZERO_FRESH_ORDINARY_AFTER_CONSUMED_GUARDED_BEFORE_RECAPTURE\",attestationBackend);\n      const recaptured=await activeCapability.resolveRecovery!(binding,guardedTip);\n      expect(recaptured.preparation.kind).toBe(\"current\");\n      await reopenedBackend.close();\n      return;"+contents.slice(end+endMarker.length);
const firstTest=contents.indexOf('  test(\n    "a staged-retired recovery source and its cancelled guarded successor advance the current seal"');
const nextTest=contents.indexOf('\n  test(',firstTest+1);assert.ok(firstTest>=0&&nextTest>firstTest);
contents=contents.slice(0,firstTest)+'  for (const attestationBackend of ["memory","sqlite"] as const) {\n    test("parent cancelled ordinary after consumed guarded recapture "+attestationBackend,async()=>{\n      await exerciseCancelledRecoveryContinuation("guarded-rebase",true,attestationBackend,0,false);\n    },30000);\n  }\n'+contents.slice(nextTest);

assert.equal(contents.split("      expect(recaptured.preparation.kind).toBe(\"current\");\n      await reopenedBackend.close();\n      return;").length,2,'final recapture anchor');contents=contents.replace("      expect(recaptured.preparation.kind).toBe(\"current\");\n      await reopenedBackend.close();\n      return;","\n      expect(recaptured.preparation.kind).toBe(\"current\");\n      if(recaptured.preparation.kind!==\"current\")throw Error(\"missing current recovery\");\n      const resumedFinalChild={childId:\"implement-worker#parent-after-empty-cancel-\"+attestationBackend,runId:\"parent-after-empty-cancel-\"+attestationBackend};\n      const resumedFinal=await activeCapability.prepare({\n        roleId:\"implement-worker\",input:{taskId:\"T2081\",headline:\"supervise exact tip\",description:\"run the full gate outside the workspace-write sandbox\",\n          acceptance:\"only a green exact tip becomes consumable\",worktreePath:subject.managed.handle.absolutePath,branch:subject.managed.handle.branch,\n          baseCommit:guardedBase,round:5,startingCommit:guardedTip,validationIntent:\"final\",priorResultCommit:guardedTip},\n        idempotencyKey:\"parent-after-empty-cancel-\"+String(sequence),timeoutMs:600_000,expectedChild:resumedFinalChild,recoveryPreparation:recaptured.preparation.recoveryPreparation});\n      if(!resumedFinal.accepted||resumedFinal.prepared.gitChangeCapability===undefined)throw Error(\"current recovery did not prepare\");\n      await activeCapability.fetchInput({...resumedFinal.handle,inputCapability:resumedFinal.prepared.inputCapability});\n      const newPath=\"parent-after-empty-cancel.txt\",newBytes=\"resumed\\n\";\n      await fs.writeFile(path.join(subject.managed.handle.absolutePath,newPath),newBytes);\n      const finalReceipt=await activeCapability.gitCommit!({...resumedFinal.handle,gitChangeCapability:resumedFinal.prepared.gitChangeCapability,\n        operationId:\"parent-after-empty-cancel-\"+String(sequence),expectedHead:guardedTip,message:\"resume after empty ordinary cancellation\",\n        changes:[{kind:\"add\",path:newPath,newState:{mode:\"100644\",digest:sha256(newBytes)}}]});\n      expect(await activeCapability.storeResult({resultCapability:resumedFinal.prepared.resultCapability,\n        output:{...subject.output,resultCommit:finalReceipt.newHead,filesTouched:[\"file.txt\",newPath],gitReceipts:[{...finalReceipt,paths:[...finalReceipt.paths],objectOids:[...finalReceipt.objectOids]}],\n        baseVerification:{status:\"verified\",relation:\"descendant\",baseCommit:guardedBase,headCommit:finalReceipt.newHead}}})).toMatchObject({state:\"gate-pending\"});\n      console.log(\"RECOVERED_EMPTY_ORDINARY_SUCCESSOR_BEFORE_QUEUE_QUALIFICATION\",attestationBackend);\n      const finalQualified=await qualify(resumedFinal.prepared,resumedFinalChild,\"2026-08-12T20:00:16.000Z\");\n      expect(finalQualified.state).toBe(\"queued\");\n      expect(runner.requests).toHaveLength(2);\n      if(finalQualified.state!==\"queued\")throw Error(\"qualification failed\");\n      const finalCoordinate={partitionKey:finalQualified.partitionKey,holderId:\"parent-after-empty-cancel-final\"};\n      expect(await activeCapability.coordinateImplementationCandidate!(finalCoordinate)).toMatchObject({state:\"completed\",handle:resumedFinal.handle});\n      expect(runner.requests).toHaveLength(3);\n      expect(await activeCapability.coordinateImplementationCandidate!(finalCoordinate)).toMatchObject({state:\"empty\"});\n      expect(runner.requests).toHaveLength(3);\n      expect(await activeCapability.fetch(resumedFinal.handle)).toMatchObject({state:\"consumed\",output:{status:\"pass\",resultCommit:finalReceipt.newHead}});\n      await reopenedBackend.close();\n      return;");


function replaceOnce(before,after){assert.equal(contents.split(before).length,2,"unique fixture anchor "+before.slice(0,75));contents=contents.replace(before,after);}
const runnerStart=contents.indexOf("class ParentLossThenGreenGateDummy");
const runnerEnd=contents.indexOf("class GateRejectedThenParentLossThenGreenGateDummy",runnerStart);
assert.ok(runnerStart>=0&&runnerEnd>runnerStart);
let runnerText=contents.slice(runnerStart,runnerEnd);
runnerText=runnerText.replace('    return {\n      gateExitCode: 0,','    if(this.requests.length===3)return {gateExitCode:1,passCount:16,failCount:1,gateDurationMs:1,capturedAt:"2026-08-12T20:00:17.000Z",outputTail:"16 pass\\n1 fail"};\n    return {\n      gateExitCode: 0,');
contents=contents.slice(0,runnerStart)+runnerText+contents.slice(runnerEnd);
const coordinateStart=contents.indexOf('      expect(await activeCapability.coordinateImplementationCandidate!(finalCoordinate))');
const coordinateEnd=contents.indexOf('      await reopenedBackend.close();\n      return;',coordinateStart);
assert.ok(coordinateStart>=0&&coordinateEnd>coordinateStart);
contents=contents.slice(0,coordinateStart)+
'      await expect(activeCapability.coordinateImplementationCandidate!(finalCoordinate)).rejects.toThrow();\n'+
'      expect(runner.requests).toHaveLength(3);\n'+
'      expect(await activeCapability.fetch(resumedFinal.handle)).toMatchObject({state:"aborted",reason:"gate-rejected"});\n'+
'      const correctionChild={childId:"implement-worker#parent-zero-red-correction-"+attestationBackend,runId:"parent-zero-red-correction-"+attestationBackend};\n'+
'      const correction=await activeCapability.prepare({roleId:"implement-worker",input:{taskId:"T2081",headline:"supervise exact tip",description:"run the full gate outside the workspace-write sandbox",acceptance:"only a green exact tip becomes consumable",worktreePath:subject.managed.handle.absolutePath,branch:subject.managed.handle.branch,baseCommit:guardedBase,round:6,startingCommit:finalReceipt.newHead,validationIntent:"final",priorResultCommit:finalReceipt.newHead},idempotencyKey:"parent-zero-red-correction-"+String(sequence),timeoutMs:600_000,expectedChild:correctionChild,reprepareOf:resumedFinal.handle});\n'+
'      if(!correction.accepted)throw Error("PUBLIC_GENUINE_RED_CORRECTION_REFUSED:"+JSON.stringify({reason:correction.reason,path:correction.path,detail:correction.detail}));\n'+
'      expect(correction.accepted).toBe(true);\n'+
'      expect(runner.requests).toHaveLength(3);\n'+
contents.slice(coordinateEnd);

const correctionStart=contents.indexOf('const correctionChild=');const correctionClose=contents.indexOf('      await reopenedBackend.close();\n      return;',correctionStart);assert.ok(correctionStart>=0&&correctionClose>correctionStart);contents=contents.slice(0,correctionClose)+"\n      expect(await activeCapability.fetchInput({...correction.handle,inputCapability:correction.prepared.inputCapability})).toMatchObject({state:\"input-materialized\"});\n      if(correction.prepared.gitChangeCapability===undefined)throw Error(\"correction broker missing\");\n      const cancelPath=\"cancelled-correction.txt\",cancelBytes=\"retained correction\\n\";\n      await fs.writeFile(path.join(subject.managed.handle.absolutePath,cancelPath),cancelBytes);\n      const cancelReceipt=await activeCapability.gitCommit!({...correction.handle,gitChangeCapability:correction.prepared.gitChangeCapability,operationId:\"cancelled-correction-\"+String(sequence),expectedHead:finalReceipt.newHead,message:\"preserve partial correction\",changes:[{kind:\"add\",path:cancelPath,newState:{mode:\"100644\",digest:sha256(cancelBytes)}}]});\n      expect(await activeCapability.abort({...correction.handle,reason:\"cancelled\"})).toMatchObject({state:\"aborted\",reason:\"cancelled\"});\n      const correctionRecapture=await activeCapability.resolveRecovery!(binding,cancelReceipt.newHead);\n      expect(correctionRecapture.preparation.kind).toBe(\"current\");\n      console.log(\"CANCELLED_GENUINE_RED_CORRECTION_RECAPTURED\",attestationBackend);\n"+contents.slice(correctionClose);

const lifecycleAnchor=String.raw`      const correctionRecapture=await activeCapability.resolveRecovery!(binding,cancelReceipt.newHead);
      expect(correctionRecapture.preparation.kind).toBe("current");
      console.log("CANCELLED_GENUINE_RED_CORRECTION_RECAPTURED",attestationBackend);`;
const lifecycleReplacement=String.raw`      const correctionRecapture=await activeCapability.resolveRecovery!(binding,cancelReceipt.newHead);
      expect(correctionRecapture.preparation.kind).toBe("current");
      if(correctionRecapture.preparation.kind!=="current")throw Error("cancelled genuine-red correction did not recapture");
      console.log("CANCELLED_GENUINE_RED_CORRECTION_RECAPTURED",attestationBackend);

      const resumedAfterCorrectionChild={childId:"implement-worker#post-cancel-recovery-"+attestationBackend,runId:"post-cancel-recovery-"+attestationBackend};
      const resumedAfterCorrection=await activeCapability.prepare({
        roleId:"implement-worker",input:{taskId:"T2081",headline:"supervise exact tip",description:"run the full gate outside the workspace-write sandbox",
          acceptance:"only a green exact tip becomes consumable",worktreePath:subject.managed.handle.absolutePath,branch:subject.managed.handle.branch,
          baseCommit:guardedBase,round:7,startingCommit:cancelReceipt.newHead,validationIntent:"final",priorResultCommit:cancelReceipt.newHead},
        idempotencyKey:"post-cancel-recovery-"+String(sequence),timeoutMs:600_000,expectedChild:resumedAfterCorrectionChild,
        recoveryPreparation:correctionRecapture.preparation.recoveryPreparation});
      if(!resumedAfterCorrection.accepted||resumedAfterCorrection.prepared.gitChangeCapability===undefined)throw Error("post-cancel recovery did not prepare");
      expect(await activeCapability.fetchInput({...resumedAfterCorrection.handle,inputCapability:resumedAfterCorrection.prepared.inputCapability})).toMatchObject({state:"input-materialized"});
      const postPath="post-cancel-recovery.txt",postBytes="completed recovered lifecycle\n";
      await fs.writeFile(path.join(subject.managed.handle.absolutePath,postPath),postBytes);
      const postReceipt=await activeCapability.gitCommit!({...resumedAfterCorrection.handle,gitChangeCapability:resumedAfterCorrection.prepared.gitChangeCapability,
        operationId:"post-cancel-recovery-"+String(sequence),expectedHead:cancelReceipt.newHead,message:"complete recovered lifecycle",
        changes:[{kind:"add",path:postPath,newState:{mode:"100644",digest:sha256(postBytes)}}]});
      const recoveredFiles=(await git(subject.managed.handle.absolutePath,["diff","--name-only",guardedBase+".."+postReceipt.newHead])).split("\n").filter(Boolean).sort();
      expect(await activeCapability.storeResult({resultCapability:resumedAfterCorrection.prepared.resultCapability,
        output:{...subject.output,resultCommit:postReceipt.newHead,filesTouched:recoveredFiles,
          gitReceipts:[{...postReceipt,paths:[...postReceipt.paths],objectOids:[...postReceipt.objectOids]}],
          baseVerification:{status:"verified",relation:"descendant",baseCommit:guardedBase,headCommit:postReceipt.newHead}}})).toMatchObject({state:"gate-pending"});
      const postQualified=await qualify(resumedAfterCorrection.prepared,resumedAfterCorrectionChild,"2026-08-12T20:00:20.000Z");
      if(postQualified.state!=="queued")throw Error("post-cancel result did not qualify");
      expect(await activeCapability.coordinateImplementationCandidate!({partitionKey:postQualified.partitionKey,holderId:"post-cancel-recovery-final"})).toMatchObject({state:"completed",handle:resumedAfterCorrection.handle});
      expect(runner.requests).toHaveLength(4);
      expect(await activeCapability.fetch(resumedAfterCorrection.handle)).toMatchObject({state:"consumed",output:{status:"pass",resultCommit:postReceipt.newHead}});

      const ledgerRuntime=await import("@cq/ledger");
      const evidenceRuntime=await import("../src/implementationEvidenceRuntime.js");
      const evidenceCanonical=(value:unknown):string=>{
        if(value===null||typeof value==="string"||typeof value==="boolean"||typeof value==="number")return JSON.stringify(value);
        if(Array.isArray(value))return "["+value.map(evidenceCanonical).join(",")+"]";
        const record=value as Record<string,unknown>;
        return "{"+Object.keys(record).sort().map((key)=>JSON.stringify(key)+":"+evidenceCanonical(record[key])).join(",")+"}";
      };
      const evidenceHash=(value:unknown)=>createHash("sha256").update(evidenceCanonical(value)).digest("hex");
      const manifestId="d347-implementation-evidence-activation-v2";
      const priorRequirementRef="cq-implementation-evidence-activation-requirement:v1:"+"1".repeat(64);
      const priorActivationRef="cq-implementation-evidence-activation:v1:"+"2".repeat(64);
      const priorTaskRefs=["tasks:T3000","tasks:T3001"] as const;
      const priorManifest={version:1 as const,manifestId,sourceDigest:"6".repeat(64),records:priorTaskRefs.map((taskRef,index)=>({
        recordKey:manifestId+":"+taskRef.slice("tasks:".length),taskRef,ownerGoalRef:"goals:G176",finalizedManifest:"finalized-v2\n",historicalReview:null,
        baseCommit:(index===0?"7":"8").repeat(40),resultCommit:(index===0?"9":"d").repeat(40),repositoryHead:guardedBase,
        diff:"diff-"+taskRef,acceptance:{text:"accepted"},gateObservations:{gate:"green"},requiredObservations:["task-authority"]})),
        activation:{goalRef:"goals:G176",finalizedManifestDigest:"c".repeat(64),evidenceTaskKey:"t-evidence",auditTaskKey:"t-historical-evidence",activationTaskKey:"t-activate-evidence"}};
      const priorManifestDigest=ledgerRuntime.implementationAuditManifestDigest(priorManifest);
      const priorAuditRefs=priorManifest.records.map((record)=>"cq-implementation-audit:v1:"+evidenceHash({manifestId,manifestDigest:priorManifestDigest,sourceDigest:priorManifest.sourceDigest,record,attemptRefs:[]}));
      const evidenceStore=ledgerRuntime.createInMemoryImplementationEvidenceStore({version:2,adoptions:{},panels:{},attempts:{},completions:{},auditPanels:{},auditAttempts:{},
        implementationAudits:Object.fromEntries(priorAuditRefs.map((auditRef,index)=>{const record=priorManifest.records[index]!;return[auditRef,{version:1,auditRef,manifestId,manifestDigest:priorManifestDigest,
          recordKey:record.recordKey,taskRef:record.taskRef,ownerGoalRef:record.ownerGoalRef,finalizedManifest:record.finalizedManifest,historicalReview:null,
          baseCommit:record.baseCommit,resultCommit:record.resultCommit,repositoryHead:guardedBase,sourceDigest:priorManifest.sourceDigest,
          evidenceFingerprint:evidenceHash({record,attemptRefs:[],manifestDigest:priorManifestDigest}),attemptRefs:[],terminalState:"approved",author:"parent",session:null,appliedAt:"2026-08-12T19:00:00.000Z"}]})),
        auditManifestApplications:{},activationRequirements:{[priorRequirementRef]:{version:1,requirementRef:priorRequirementRef,manifestId,manifestDigest:priorManifestDigest,
          sourceDigest:priorManifest.sourceDigest,semanticManifestDigest:ledgerRuntime.implementationAuditManifestSemanticDigest(priorManifest),goalRef:"goals:G176",
          finalizedManifestDigest:priorManifest.activation.finalizedManifestDigest,evidenceTaskRef:priorTaskRefs[0],auditTaskRef:priorTaskRefs[1],activationTaskRef:"tasks:T3002",
          boundaryCommit:guardedBase,taskRefs:priorTaskRefs,state:"fulfilled",activationRef:priorActivationRef,previousRequirementRef:null,continuationRef:null,
          operationId:"arm-v2",requestDigest:"a".repeat(64),author:"parent",session:null,armedAt:"2026-08-12T18:00:00.000Z",fulfilledAt:"2026-08-12T19:00:00.000Z"}},
        activations:{[priorActivationRef]:{version:1,activationRef:priorActivationRef,requirementRef:priorRequirementRef,manifestId,manifestDigest:priorManifestDigest,
          repositoryHead:guardedBase,evidenceFingerprint:evidenceHash({manifestId,manifestDigest:priorManifestDigest,sourceDigest:priorManifest.sourceDigest,repositoryHead:guardedBase,auditRefs:priorAuditRefs,taskRefs:priorTaskRefs}),
          auditRefs:priorAuditRefs,taskRefs:priorTaskRefs,author:"parent",session:null,activatedAt:"2026-08-12T19:00:00.000Z"}},activationContinuations:{},bootstraps:{}} as never);
      const evidenceCapability=createDispatchCapability({...subject.capabilityOptions,backend:reopenedBackend,recoveryJournal,implementationSuccessorLauncher,implementationEvidenceStore:evidenceStore});
      if(evidenceCapability.observeEvidence===undefined||evidenceCapability.resolveImplementationCandidateAuthority===undefined||evidenceCapability.verifyImplementationLineage===undefined)throw Error("protected recovered evidence runtime is unavailable");
      const reviewer={alias:"recovered-reviewer",harness:"pi",model:"fixture",provider:"fixture",launch:"adapter" as const,adapterId:"pi:fixture"};
      const fallback={alias:"native",harness:"codex",model:"fixture",provider:null,launch:"native" as const,adapterId:"codex:native"};
      let taskStatus:"wip"|"done"="wip";
      let completionReview:{reviewRef:string;status:"go-ahead";implementationEvidence:string}|undefined;
      const taskFinalizedManifest="g2081-finalized\n";
      const retained=async(input:{repositoryHead:string;resultCommit:string})=>{try{await git(subject.repositoryRoot,["merge-base","--is-ancestor",input.resultCommit,input.repositoryHead]);return true;}catch{return false;}};
      const evidenceDependencies={store:evidenceStore,resolveReviewerRoster:()=>[reviewer],nativeFallback:fallback,now:()=>"2026-08-12T20:00:21.000Z",
        prepareNativeReview:async()=>{throw Error("native review is unused");},fetchNativeReview:async()=>{throw Error("native review is unused");},
        executeExternalReview:async()=>({adapterIdentity:reviewer.adapterId,stderr:"",exitCode:0,stdout:JSON.stringify({taskId:"T2081",verdict:"approve",criticism:[],questions:[],defects:[],
          rationale:"authenticated recovered history is mergeable",gateReRan:false,gateDurationMs:0,resultCommitVerified:true,
          resultCommitEvidence:{status:"verified",resultCommit:postReceipt.newHead,branchTip:postReceipt.newHead},
          baseAncestry:{status:"verified",relation:"descendant",baseCommit:guardedBase,resultCommit:postReceipt.newHead,mergeBase:guardedBase}})}),
        fetchWorker:async(dispatch:{attestationId:string;generation:number})=>{const observed=await evidenceCapability.observeEvidence!(dispatch);return observed.state==="consumed"?{state:"consumed" as const,input:observed.input,output:observed.output}:{state:observed.state==="aborted"?"aborted" as const:"missing" as const};},
        resolveCandidateAuthority:async(input:never)=>await evidenceCapability.resolveImplementationCandidateAuthority!(input),
        readTaskAuthority:async(taskRef:string)=>priorTaskRefs.includes(taskRef as never)?{taskRef,ownerGoalRef:"goals:G176",status:"done" as const,finalizedManifest:"finalized-v2\n"}:
          {taskRef,ownerGoalRef:"goals:G2081",status:taskStatus,finalizedManifest:taskFinalizedManifest},
        repositoryHead:async()=>await git(subject.repositoryRoot,["rev-parse","HEAD"]),
        isResultDescendantOfRepositoryHead:async(input:{repositoryHead:string;resultCommit:string})=>await retained({repositoryHead:input.resultCommit,resultCommit:input.repositoryHead}),
        isCommitRetained:retained,
        verifyImplementation:async(input:any)=>{if(input.worker.state!=="consumed")throw Error("worker evidence is not consumed");const authenticated=await evidenceCapability.verifyImplementationLineage!({workerDispatch:input.workerDispatch,resultCommit:input.resultCommit});
          return await evidenceRuntime.verifyProductionImplementation(subject.repositoryRoot,input.resultCommit,input.worker.input as Record<string,DispatchJSONValue>,input.worker.output as Record<string,DispatchJSONValue>,authenticated);},
        verifyImplementationLineage:async(input:{workerDispatch:{attestationId:string;generation:number};resultCommit:string})=>await evidenceCapability.verifyImplementationLineage!(input),
        recordLedgerCompletion:async({completion}:any)=>{taskStatus="done";completionReview={reviewRef:"reviews:R2081",status:"go-ahead",implementationEvidence:JSON.stringify({version:1,completionRef:completion.completionRef,
          taskRef:completion.taskRef,resultCommit:completion.resultCommit,evidenceFingerprint:completion.evidenceFingerprint,reviewAttemptRefs:completion.reviewAttemptRefs})};return{reviewRef:completionReview.reviewRef};},
        readCompletionReview:async(reviewRef:string)=>{if(completionReview===undefined||completionReview.reviewRef!==reviewRef)throw Error("completion review is unavailable");return completionReview;},
        readAuditManifest:async()=>priorManifest,resolveActivationCohort:async()=>({finalizedManifestDigest:priorManifest.activation.finalizedManifestDigest,evidenceTaskRef:priorTaskRefs[0],auditTaskRef:priorTaskRefs[1],
          activationTaskRef:"tasks:T3002",boundaryCommit:postReceipt.newHead,taskRefs:priorTaskRefs}),startupBuildCommit:guardedBase,implementationEvidenceProtocolVersion:2,packagedManifestInventory:[manifestId]} as never;
      const evidenceService=new ledgerRuntime.ImplementationEvidenceService(evidenceDependencies);
      const panel=await evidenceService.prepareReviewPanel({taskRef:"tasks:T2081",resultCommit:postReceipt.newHead,workerDispatch:resumedAfterCorrection.handle,operationId:"recovered-panel-"+attestationBackend,author:"parent"});
      const attemptRef=panel.attemptRefs[0]!;
      expect(await evidenceService.prepareReviewAttempt({panelRef:panel.panelRef,attemptRef,operationId:"recovered-attempt-"+attestationBackend,author:"parent"})).toMatchObject({status:"prepared",launch:"adapter"});
      await evidenceService.executeExternalReviewAttempt({attemptRef,operationId:"recovered-execute-"+attestationBackend,author:"parent"});
      expect(await evidenceService.finalizeReviewAttempt({attemptRef,operationId:"recovered-finalize-"+attestationBackend,author:"parent"})).toMatchObject({terminalState:"approved"});
      expect(await git(subject.repositoryRoot,["rev-parse","HEAD"])).toBe(guardedBase);
      const mergeOperationId="recovered-merge-"+attestationBackend;
      const completion=await evidenceService.prepareCompletion({taskRef:"tasks:T2081",expectedRepositoryHead:guardedBase,resultCommit:postReceipt.newHead,workerDispatch:resumedAfterCorrection.handle,
        reviewAttemptRefs:[attemptRef],completion:"authenticated recovered lifecycle",logPaths:[],mergeOperationId,operationId:"recovered-completion-"+attestationBackend,author:"parent"});
      const mergeBinding={kind:"merge" as const,targetRef:"tasks:T2081",repositoryRoot:subject.repositoryRoot,commit:postReceipt.newHead,completionRef:completion.completionRef,mergeOperationId};
      await evidenceService.assertMergeAdmission(mergeBinding,guardedBase);
      await evidenceService.markMergeStarted(completion.completionRef,guardedBase);
      await git(subject.repositoryRoot,["merge","--ff-only",postReceipt.newHead]);
      await evidenceService.markMerged(completion.completionRef,postReceipt.newHead);
      const recorded=await evidenceService.recordCompletion({taskRef:"tasks:T2081",expectedRepositoryHead:postReceipt.newHead,operationId:"recovered-record-"+attestationBackend,author:"parent"});
      expect(recorded).toMatchObject({status:"recorded",completionRef:completion.completionRef,resultCommit:postReceipt.newHead});
      const activationInput={goalRef:"goals:G176",manifestId,priorRequirementRef,completedTaskRef:"tasks:T2081",completionRef:completion.completionRef,expectedFromHead:guardedBase,
        expectedRepositoryHead:postReceipt.newHead,operationId:"recovered-activation-"+attestationBackend,author:"parent"} as const;
      const activated=await evidenceService.continueEvidenceActivation(activationInput);
      expect(activated).toMatchObject({status:"continued",completionRef:completion.completionRef,fromHead:guardedBase,repositoryHead:postReceipt.newHead});
      expect(await new ledgerRuntime.ImplementationEvidenceService(evidenceDependencies).continueEvidenceActivation(activationInput)).toEqual({...activated,status:"existing"});
      console.log("RECOVERED_GENUINE_RED_COMPLETION_ACTIVATION_REPLAY",attestationBackend);
`;
replaceOnce(lifecycleAnchor,lifecycleReplacement);

plugin({name:"cq-readonly-frozen-fixture-ordinary-epoch",setup(b){b.onLoad({filter:/\/packages\/ledger-mcp\/test\/supervisedWorkerGateStorage\.test\.ts$/},()=>({contents,loader:"ts",resolveDir:path.dirname(target)}));b.onLoad({filter:/\/packages\/[^/]+\/src\/.*\.ts$/},a=>{const marker="/packages/",index=a.path.lastIndexOf(marker);if(index<0)throw Error("composed package source is outside the runtime root: "+a.path);const relative=a.path.slice(index+1),resolved=source+"/"+relative;if(/(dispatchCapability|currentRecoverySeal|dispatchRecoverySeal)\.ts$/.test(relative))console.log("IMMUTABLE_COMPOSED_RUNTIME_MODULE",relative,"@"+source);return{contents:readFileSync(resolved,"utf8"),loader:"ts",resolveDir:path.dirname(resolved)};});}});
