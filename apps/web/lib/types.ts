export type DataStatus =
  | "SYNTHETIC"
  | "PUBLIC_SAMPLE"
  | "USER_PROVIDED"
  | "ENTERPRISE_AUTHORIZED";

export type AgentMode = "OFFLINE_REPLAY" | "LIVE";

export type DecisionOutcome =
  | "GO"
  | "PIVOT"
  | "NO_GO"
  | "EVIDENCE_INSUFFICIENT";

export type ApprovalGate =
  | "EXPERIMENT_PLAN"
  | "DECISION"
  | "PIVOT_REVISION"
  | "FIRST_ORDER_ASSUMPTIONS";

export type ApprovalDecision =
  | "APPROVE"
  | "REJECT"
  | "REQUEST_CHANGES"
  | "REQUEST_MORE_DATA";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface DemoScenario {
  id: string;
  name: string;
  description: string;
  expected_outcome: DecisionOutcome;
  total_days: number;
  category?: string;
  key_signal?: string;
}

export interface ProductBrief {
  id?: string;
  version?: number;
  product_name?: string;
  candidate_id?: string;
  category?: string;
  target_audience?: string;
  usage_scenario?: string;
  season?: string;
  target_price?: number;
  target_price_fen?: number;
  estimated_cost?: number;
  estimated_cost_fen?: number;
  gross_margin_floor_bps?: number;
  moq?: number;
  lead_time_days?: number;
  expected_lead_time_days?: number;
  target_launch_days?: number;
  trial_budget?: number;
  trial_budget_fen?: number;
  production_budget_fen?: number;
  channel?: string;
  business_goal?: string;
  core_selling_points?: string[];
  constraints?: string[];
  known_risks?: string[];
  candidates?: Array<Record<string, JsonValue>>;
  variants?: Array<{
    id: string;
    label: string;
    color_name: string;
    color_hex?: string;
    material_notes?: string;
    image_url?: string;
    target_price_fen: number;
  }>;
  first_order_assumptions?: {
    intent_to_order_rate: number;
    planned_reach: number;
    packing_step: number;
    source: "DEMO_PROPOSAL" | "USER_PROPOSAL";
  } | null;
  data_status?: DataStatus;
  [key: string]: unknown;
}

export interface ExperimentPlan {
  id?: string;
  version?: number;
  objective?: string;
  decision_question?: string;
  primary_metric?: string;
  secondary_metrics?: string[];
  hypothesis?: string;
  hypotheses?: string[];
  channel?: string;
  audience_segment?: string;
  target_audience?: string;
  duration_days?: number;
  target_sample_size?: number;
  min_exposure_per_arm?: number;
  budget?: number;
  budget_cap_fen?: number;
  controlled_variable?: string;
  invariants?: string[];
  arms?: Array<{
    id: string;
    label: string;
    variant_id: string;
    expected_share: number;
  }>;
  stop_rules?: Array<{ code: string; description: string }>;
  guardrails?: string[];
  quality_requirements?: string[];
  potential_biases?: string[];
  policy_version?: string;
  generated_by?: string;
  approval_status?: string;
  status?: string;
  [key: string]: unknown;
}

export interface DemoPolicy {
  version: string;
  revision: number;
  primary_metric: string;
  min_exposure_per_arm: number;
  min_purchase_intent_events_per_arm: number;
  expected_arm_share: number;
  srm_block_p_value: number;
  purchase_intent_rate_threshold: number;
  relative_uplift_threshold: number;
  gross_margin_floor_bps: number;
  interest_ctr_floor: number;
  cart_per_click_floor: number;
  clearly_low_intent_rate_ceiling: number;
  clearly_low_ctr_ceiling: number;
  conflicting_return_and_refund_rate: number;
  modifiable_supply_budget_gap_ratio: number;
  modifiable_lead_time_gap_days: number;
  modifiable_margin_gap_bps: number;
}

export interface ProjectAttachment {
  id: string;
  project_id: string;
  object_key: string;
  original_filename: string;
  mime_type: "image/jpeg" | "image/png" | "image/webp";
  size_bytes: number;
  sha256: string;
  rights_declaration: string;
  source: string;
  created_at: string;
}

export interface QualityIssue {
  issue_id?: string;
  code?: string;
  rule_code?: string;
  severity?: "BLOCK" | "WARN" | "INFO" | string;
  message?: string;
  impact?: string;
  field?: string;
  affected_rows?: number[];
  affected_fields?: string[];
  record_refs?: string[];
  observed?: JsonValue;
  expected?: JsonValue;
  handling_status?: "OPEN" | "ACKNOWLEDGED" | "RESOLVED" | string;
  [key: string]: unknown;
}

export interface QualityReport {
  status?: "PASS" | "WARN" | "BLOCK" | string;
  quality_status?: string;
  grade?: string;
  summary?: string;
  issues?: QualityIssue[];
  checks?: Array<Record<string, JsonValue>>;
  schema_version?: string;
  can_make_strong_decision?: boolean;
  row_count?: number;
  observation_days?: number;
  dataset_sha256?: string;
  rule_version?: string;
  generated_at?: string;
  [key: string]: unknown;
}

export interface MetricItem {
  key?: string;
  name?: string;
  label?: string;
  value?: number;
  unit?: string;
  delta?: number;
  [key: string]: unknown;
}

export interface MetricsReport {
  metrics?: MetricItem[];
  funnel?: Record<string, number>;
  variants?: Array<Record<string, JsonValue>>;
  summary?: string;
  total_exposure?: number;
  total_intent?: number;
  overall_intent_rate?: number;
  best_variant_id?: string | null;
  worst_variant_id?: string | null;
  relative_intent_uplift?: number | null;
  metric_version?: string;
  generated_at?: string;
  [key: string]: unknown;
}

export interface EvidenceItem {
  id?: string;
  title?: string;
  statement?: string;
  direction?: "SUPPORT" | "OPPOSE" | "NEUTRAL" | string;
  stance?: "SUPPORT" | "OPPOSE" | "NEUTRAL" | string;
  kind?: string;
  statement_type?: string;
  inference_strength?: string;
  evidence_grade?: string;
  evidence_type?: string;
  source_type?: string;
  source_ref?: string;
  source_refs?: string[];
  confidence?: string;
  metric_refs?: string[];
  counterexamples?: string[];
  limitations?: string[];
  [key: string]: unknown;
}

export interface EvidenceCard {
  id?: string;
  version?: number;
  data_status?: DataStatus;
  quality_status?: string;
  summary?: string;
  evidence_grade?: string;
  claim_type?: string;
  items?: EvidenceItem[];
  claims?: EvidenceItem[];
  limitations?: string[];
  counter_evidence?: string[];
  [key: string]: unknown;
}

export interface DecisionCard {
  id?: string;
  version?: number;
  outcome?: DecisionOutcome;
  decision?: DecisionOutcome;
  headline?: string;
  one_sentence?: string;
  summary?: string;
  evidence_grade?: string;
  quality_status?: string;
  rule_version?: string;
  policy_version?: string;
  confidence?: string;
  key_evidence?: string[];
  key_evidence_ids?: string[];
  opposing_evidence_ids?: string[];
  reason_codes?: string[];
  limitations?: string[];
  risks?: string[];
  next_actions?: string[];
  constraints?: string[];
  approval_status?: string;
  [key: string]: unknown;
}

export interface PivotRevision {
  id: string;
  decision_id: string;
  target_variant_id: string;
  version: number;
  approval_status: string;
  change_variable: string;
  change_list: string[];
  retest_plan: string[];
  created_by: string;
  created_at: string;
}

export interface FirstOrderScenario {
  name?: string;
  label?: string;
  lower?: number;
  baseline?: number;
  upper?: number;
  quantity_low?: number;
  quantity_high?: number;
  quantity_range?: string;
  rationale?: string;
  risk?: string;
  assumptions?: string[];
  constraint_notes?: string[];
  [key: string]: unknown;
}

export interface FirstOrderAssumptionsConfirmation {
  target_id: string;
  brief_version: number;
  intent_to_order_rate: number;
  planned_reach: number;
  packing_step: number;
  proposal_source: string;
  actor: string;
  comment?: string | null;
  confirmed_at: string;
}

export interface HandoffBundle {
  id?: string;
  decision_id?: string;
  pivot_revision_id?: string | null;
  outcome?: DecisionOutcome;
  techpack?: Record<string, JsonValue>;
  status?: string;
  techpack_lite?: Record<string, JsonValue>;
  sample_task?: Record<string, JsonValue>;
  first_order_recommendation?: {
    scenarios?: FirstOrderScenario[];
    [key: string]: unknown;
  };
  first_order_scenarios?: FirstOrderScenario[];
  retest_plan?: string[];
  blocked_reason?: string | null;
  watermark?: string | null;
  generated_at?: string;
  [key: string]: unknown;
}

export interface AuditEvent {
  id?: string;
  event_id?: string;
  event_type?: string;
  action?: string;
  actor?: string;
  actor_type?: string;
  from_state?: string;
  to_state?: string;
  message?: string;
  object_type?: string;
  request_id?: string;
  summary?: Record<string, JsonValue>;
  created_at?: string;
  timestamp?: string;
  metadata?: Record<string, JsonValue>;
  [key: string]: unknown;
}

export interface AgentRun {
  id: string;
  project_id: string;
  mode: AgentMode;
  operation: string;
  model_name: string | null;
  reasoning_effort: string | null;
  prompt_version: string;
  output_schema_version: string;
  recording_id: string | null;
  duration_ms: number;
  input_sha256: string;
  output_sha256: string;
  input_tokens: number | null;
  output_tokens: number | null;
  tracing_disabled: boolean;
  api_store_disabled: boolean;
  success: boolean;
  fallback_reason: string | null;
  created_at: string;
}

export interface ObjectVersion {
  project_id: string;
  object_type: string;
  object_id: string;
  object_version: number;
  payload: Record<string, JsonValue>;
  sha256: string;
  created_at: string;
}

export interface TrialObservation {
  date: string;
  candidate_id: string;
  variant_id: string;
  arm_id: string;
  channel: string;
  audience_segment: string;
  exposure: number;
  click: number;
  favorite: number;
  inquiry: number;
  add_to_cart: number;
  purchase_intent: number;
  preorder: number;
  order: number;
  refund: number;
  return_count: number;
  price_fen: number;
  spend_fen: number;
}

export interface AnalysisBundle {
  quality?: QualityReport;
  metrics?: MetricsReport;
  evidence?: EvidenceCard;
  decision?: DecisionCard;
  [key: string]: unknown;
}

export interface ProjectDetail {
  id: string;
  name?: string;
  scenario_id?: string;
  scenario_name?: string;
  state?: string;
  status?: string;
  workflow_state?: string;
  data_status?: DataStatus;
  data_origin?: DataStatus;
  data_sensitivity_level?: "SYNTHETIC_ONLY" | "USER_CONTENT_RESTRICTED";
  agent_mode?: AgentMode;
  current_day?: number;
  total_days?: number;
  created_at?: string;
  updated_at?: string;
  brief_version?: number;
  brief_missing_fields?: string[];
  policy_version?: string;
  policy_revision?: number;
  current_policy?: DemoPolicy;
  brief?: ProductBrief;
  product_brief?: ProductBrief;
  first_order_assumptions_confirmation?: FirstOrderAssumptionsConfirmation | null;
  experiment_plan?: ExperimentPlan;
  quality?: QualityReport;
  quality_report?: QualityReport;
  metrics?: MetricsReport;
  evidence?: EvidenceCard;
  evidence_card?: EvidenceCard;
  decision?: DecisionCard;
  decision_card?: DecisionCard;
  pivot_revision?: PivotRevision;
  handoff?: HandoffBundle;
  artifacts?: {
    quality?: QualityReport;
    quality_report?: QualityReport;
    metrics?: MetricsReport;
    evidence?: EvidenceCard;
    evidence_card?: EvidenceCard;
    decision?: DecisionCard;
    decision_card?: DecisionCard;
    pivot_revision?: PivotRevision;
    handoff?: HandoffBundle;
    [key: string]: unknown;
  };
  daily_observations?: Array<Record<string, JsonValue>>;
  [key: string]: unknown;
}

export interface ApprovalRequest {
  gate: ApprovalGate;
  decision: ApprovalDecision;
  actor: string;
  comment?: string;
  object_version: number;
}
