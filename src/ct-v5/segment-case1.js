(function () {
  'use strict';
  const c = window.MarketCore;
  const VERSION = 'CT-Segment-Case1-R1.0';
  const ENDPOINT_GUARD_RULE_ID = `${VERSION}/G-ENDPOINT-DIRECTIONAL-EXTREME`;
  const ENDPOINT_GUARD_RULE_STATUS = 'UNRESOLVED';
  const ENDPOINT_GUARD_RESEARCH_STATUS = 'POST_HOC_RULE_REQUIRES_THEORETICAL_REVIEW';
  const union = arrays => [...new Set(arrays.flat())];
  const freeze = value => c.deepFreeze(c.clonePlain(value));
  const id = e => e.standardizedFeatureElementId ?? e.featureElementId;
  const eq = (a,b) => c.canonicalStateJson(a) === c.canonicalStateJson(b);
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  function evaluateDirectionalExtremeEndpoint(input) {
    const prices = input.memberPrices || [];
    const tolerance = Number(input.numericTolerance ?? 0);
    if (!['UP', 'DOWN'].includes(input.direction) || !prices.length ||
        ![input.startPrice, input.endpointPrice, tolerance, ...prices].every(finite) || tolerance < 0) {
      throw new Error('INVALID_ENDPOINT_GUARD_INPUT');
    }
    const extreme = input.direction === 'UP' ? Math.max(...prices) : Math.min(...prices);
    const valid = Math.abs(input.endpointPrice - extreme) <= tolerance &&
      (input.direction === 'UP' ? input.endpointPrice > input.startPrice : input.endpointPrice < input.startPrice);
    return freeze({
      ruleId: ENDPOINT_GUARD_RULE_ID,
      ruleStatus: ENDPOINT_GUARD_RULE_STATUS,
      researchStatus: ENDPOINT_GUARD_RESEARCH_STATUS,
      comparisonDomain: 'PROSPECTIVE_TERMINATED_SEGMENT_MEMBER_PREFIX',
      extreme,
      valid,
    });
  }
  function getCase1RelevantGap(sequence, fractal, ruleConfig = {}) {
    const i = sequence.elements.findIndex(e => e.featureSequenceIndex === fractal.eventFeatureIndex);
    if (i < 1) return null;
    const [left,middle] = [sequence.elements[i-1],sequence.elements[i]];
    return freeze({...c.featureElementGap(left,middle,{ruleConfig}),
      leftElementId:id(left),rightElementId:id(middle),sequenceId:sequence.sequenceId,
      ruleVersion:VERSION,selection:'LEFT_MIDDLE'});
  }
  // Pure guard. It has no access to bars, market stores, chart objects, or mutable active tails.
  function evaluateSegmentCase1(input) {
    const {segmentState:s, featureFractal:f, standardizedSequence:q, confirmedStrokes:strokes=[],
      gapResult, currentAvailability:now} = input;
    const config = c.createCTRuleConfig(input.ruleConfig ?? {});
    const trace = {segmentId:s?.segmentId ?? null,ruleVersion:'CT-Segment-R1.0',case1RuleVersion:VERSION,
      segmentDirection:s?.direction ?? null,strokeCount:s?.strokeCount ?? 0,
      featureFractalId:f?.featureFractalId ?? null,featureFractalType:f?.type ?? null,
      featureFractalStatus:f?.status ?? null,featureFractalEventTime:f?.eventTime ?? null,
      featureFractalAvailableTime:f?.availableTime ?? null,featureFractalConfirmTime:f?.confirmTime ?? null,
      featureFractalEventRawBarIndex:f?.eventRawBarIndex ?? null,
      featureFractalAvailableRawBarIndex:f?.availableRawBarIndex ?? null,
      featureFractalConfirmRawBarIndex:f?.confirmRawBarIndex ?? null,gapDetected:null,gapSourceIds:[],
      endpointStrokeId:null,endpointFractalId:null,endpointTime:null,
      caseEvaluated:'CASE_1',caseResult:false,failureReason:null,decisionAvailableTime:now?.time ?? null};
    const result = (reason, extra={}) => freeze({eligible:reason==='ELIGIBLE',reason,eventEndpoint:null,
      confirmAvailability:null,sourceIds:null,...extra,
      decisionTrace:{...trace,caseResult:reason==='ELIGIBLE',failureReason:reason==='ELIGIBLE'?null:reason}});
    if (config.segmentRuleVersion !== 'CT-Segment-R1.0') return result('RULE_VERSION_MISMATCH');
    if (!s || (s.mode ?? s.status) !== 'EXTENDING') return result('SEGMENT_NOT_EXTENDING');
    if (!['UP','DOWN'].includes(s.direction)) return result('INVALID_SEGMENT_DIRECTION');
    if (!now || !finite(now.time) || !Number.isInteger(now.rawBarIndex) || now.rawBarIndex<0) return result('INVALID_AVAILABILITY');
    if (!f || f.status !== 'CONFIRMED') return result('FEATURE_FRACTAL_NOT_CONFIRMED');
    if (f.type !== (s.direction==='UP'?'FEATURE_TOP':'FEATURE_BOTTOM')) return result('WRONG_FEATURE_FRACTAL_TYPE');
    if (!q || q.ruleVersion !== 'CT-Segment-R1.0' || q.candidateSegmentId !== s.segmentId
        || q.segmentStartDirection !== s.direction || q.featureDirection !== (s.direction==='UP'?'DOWN':'UP'))
      return result('WRONG_FEATURE_SEQUENCE');
    if (!['STANDARDIZED','PARTIALLY_STANDARDIZED'].includes(q.standardizationStatus) || !Array.isArray(q.elements))
      return result('SOURCE_NOT_STABLE');
    const pos=q.elements.findIndex(e=>e.featureSequenceIndex===f.eventFeatureIndex);
    const triple=q.elements.slice(pos-1,pos+2);
    if (pos<1 || triple.length!==3 || triple.some(e=>e.status!=='STANDARDIZED'
        || e.ruleVersion!=='CT-Segment-R1.0' || e.sequenceId!==q.sequenceId
        || e.candidateSegmentId!==s.segmentId || e.metadata?.sealingPolicy!=='NON_INCLUDING_SUCCESSOR'))
      return result('SOURCE_NOT_STABLE');
    // Revalidate the detector output against sealed evidence; a forged CONFIRMED label is insufficient.
    let trusted;
    try { trusted=c.detectFeatureFractals({...q,standardizationStatus:'STANDARDIZED'},{ruleConfig:config})
      .confirmedFeatureFractals.find(e=>e.featureFractalId===f.featureFractalId); }
    catch { return result('INVALID_FEATURE_EVIDENCE'); }
    if (!trusted || !eq(trusted,f)) return result('FEATURE_FRACTAL_EVIDENCE_MISMATCH');
    const isAvailable=(index,time)=>Number.isInteger(index)&&index>=0&&finite(time)&&index<=now.rawBarIndex&&time<=now.time;
    if (!isAvailable(f.confirmRawBarIndex,f.confirmTime)
        || q.elements.some(e=>!isAvailable(e.standardizationAvailableRawBarIndex,e.standardizationAvailableTime)
          || e.standardizationAvailableTime<e.sourceEndTime || e.standardizationAvailableRawBarIndex<e.sourceRawEndIndex)
        || strokes.some(b=>b.status!=='CONFIRMED'||!isAvailable(b.confirmIndex,b.confirmTime)
          || b.confirmTime<b.endTime || b.confirmIndex<b.endIndex)) return result('SOURCE_NOT_AVAILABLE');
    const gap=getCase1RelevantGap(q,f,config);
    trace.gapDetected=gap.hasGap;trace.gapSourceIds=[gap.leftElementId,gap.rightElementId];
    if (!gapResult || gapResult.sequenceId!==gap.sequenceId || gapResult.leftElementId!==gap.leftElementId
        || gapResult.rightElementId!==gap.rightElementId || gapResult.hasGap!==gap.hasGap) return result('GAP_EVIDENCE_MISMATCH');
    if (gap.hasGap) return result('GAP_REQUIRES_CASE2',{caseAction:'CASE1_BLOCKED_BY_GAP'});
    const byId=new Map(strokes.map(b=>[b.strokeId,b]));
    if (byId.size!==strokes.length || s.strokeCount!==strokes.length || !Array.isArray(s.strokeIds) || !eq(s.strokeIds,strokes.map(b=>b.strokeId))) return result('STROKE_PROVENANCE_MISMATCH');
    const evidenceIds=union(triple.map(e=>[...e.sourceStrokeIds,...(e.metadata?.witnessStrokeIds??[])]));
    if (evidenceIds.some(x=>!byId.has(x))) return result('STROKE_PROVENANCE_MISMATCH');
    const middle=triple[1], target=s.direction==='UP'?middle.high:middle.low;
    // Stable earliest extreme tie-break. The reverse feature stroke START is the segment endpoint.
    const candidates=strokes.map((b,i)=>({b,i})).filter(({b})=>middle.sourceStrokeIds.includes(b.strokeId)
      && b.direction===q.featureDirection && Math.abs(b.startPrice-target)<=config.numericTolerance);
    const hit=candidates[0];
    if (!hit || hit.i===0) return result('ENDPOINT_UNRESOLVED');
    const endpoint=strokes[hit.i-1], next=hit.b, members=strokes.slice(0,hit.i);
    if (members.length<config.minimumSegmentStrokeCount || members.length%2!==1) return result('INSUFFICIENT_STROKE_STRUCTURE');
    if (members[0].strokeId!==s.startStrokeId || members[0].direction!==s.direction || endpoint.direction!==s.direction
        || !next.startFractalId || endpoint.endFractalId!==next.startFractalId
        || endpoint.endIndex!==next.startIndex || endpoint.endTime!==next.startTime
        || Math.abs(endpoint.endPrice-next.startPrice)>config.numericTolerance) return result('ENDPOINT_PROVENANCE_MISMATCH');
    for (let i=0;i<members.length;i++) {
      const b=members[i],prev=members[i-1];
      if (![b.startPrice,b.endPrice,b.startTime,b.endTime].every(finite) || b.endTime<b.startTime
          || b.endIndex<b.startIndex || (b.direction==='UP'? b.endPrice<=b.startPrice:b.endPrice>=b.startPrice)
          || (prev && (b.direction===prev.direction || prev.endFractalId!==b.startFractalId
          || prev.endTime!==b.startTime || prev.endIndex!==b.startIndex || Math.abs(prev.endPrice-b.startPrice)>config.numericTolerance)))
        return result('INVALID_STROKE_STRUCTURE');
    }
    const prices=members.flatMap(b=>[b.startPrice,b.endPrice]);
    const endpointGuard=evaluateDirectionalExtremeEndpoint({direction:s.direction,
      startPrice:members[0].startPrice,endpointPrice:endpoint.endPrice,
      memberPrices:prices,numericTolerance:config.numericTolerance});
    const extreme=endpointGuard.extreme;
    Object.assign(trace,{endpointStrokeId:endpoint.strokeId,endpointFractalId:endpoint.endFractalId,endpointTime:endpoint.endTime,
      endpointAvailableTime:endpoint.availableTime ?? endpoint.confirmTime,
      endpointRawBarIndex:endpoint.endIndex,
      endpointAvailableRawBarIndex:endpoint.availableRawBarIndex ?? endpoint.confirmRawBarIndex ?? endpoint.confirmIndex,
      proposedEndpointPrice:endpoint.endPrice,directionalExtremePrice:extreme,
      endpointGuardRuleId:endpointGuard.ruleId,endpointGuardRuleStatus:endpointGuard.ruleStatus});
    if (!endpointGuard.valid)
      return result('INVALID_DIRECTIONAL_ENDPOINT');
    const first=members.slice(0,3);
    if (Math.max(...first.map(b=>Math.min(b.startPrice,b.endPrice)))>
        Math.min(...first.map(b=>Math.max(b.startPrice,b.endPrice)))+config.priceTolerance) return result('NO_INITIAL_THREE_STROKE_OVERLAP');
    if (!isAvailable(endpoint.endIndex,endpoint.endTime)) return result('SOURCE_NOT_AVAILABLE');
    const eventEndpoint={endpointStrokeId:endpoint.strokeId,endpointFractalId:endpoint.endFractalId,
      endpointRawBarIndex:endpoint.endIndex,endpointPrice:endpoint.endPrice,endpointTime:endpoint.endTime,
      endpointAvailableRawBarIndex:endpoint.availableRawBarIndex ?? endpoint.confirmRawBarIndex ?? endpoint.confirmIndex,
      endpointAvailableTime:endpoint.availableTime ?? endpoint.confirmTime};
    Object.assign(trace,eventEndpoint,{strokeCount:members.length});
    return result('ELIGIBLE',{eventEndpoint,confirmAvailability:now,
      sourceIds:{sourceFeatureFractalId:f.featureFractalId,sourceStandardizedFeatureIds:triple.map(id),
        sourceFeatureElementIds:union(triple.map(e=>e.sourceFeatureElementIds)),
        sourceStrokeIds:union([evidenceIds,members.map(b=>b.strokeId)]),confirmationEvidenceStrokeIds:evidenceIds,segmentStrokeIds:members.map(b=>b.strokeId)},
      decisionTrace:trace});
  }
  Object.assign(c,{SEGMENT_ENDPOINT_GUARD_RULE_ID:ENDPOINT_GUARD_RULE_ID,
    SEGMENT_ENDPOINT_GUARD_RULE_STATUS:ENDPOINT_GUARD_RULE_STATUS,
    SEGMENT_ENDPOINT_GUARD_RESEARCH_STATUS:ENDPOINT_GUARD_RESEARCH_STATUS,
    evaluateDirectionalExtremeEndpoint,
    SEGMENT_CASE1_RULE:freeze({ruleVersion:'CT-Segment-R1.0',case1RuleVersion:VERSION,
    case1RequiresConfirmedFeatureFractal:true,case1RequiresNoGap:true,case1UsesStandardizedFeatureSequence:true,
    case1AllowsRawFeatureSequence:false,case1AllowsPendingFeatureFractal:false,minimumStrokeCountConfig:'minimumSegmentStrokeCount',
    relevantGap:'LEFT_MIDDLE',endpointTieBreak:'EARLIEST_SOURCE',
    endpointGuard:{ruleId:ENDPOINT_GUARD_RULE_ID,ruleStatus:ENDPOINT_GUARD_RULE_STATUS,
      researchStatus:ENDPOINT_GUARD_RESEARCH_STATUS,
      comparisonDomain:'PROSPECTIVE_TERMINATED_SEGMENT_MEMBER_PREFIX'},
    candidateScope:'SINGLE_CANDIDATE'}),SEGMENT_CASE1_RULE_VERSION:VERSION,getCase1RelevantGap,evaluateSegmentCase1});
})();
