# plan_coding Implementation Slices

Generated from PRD discussion on 2026-05-12.

---

## Slice 1: Schema + Prompt Foundation

**Type**: AFK | **Blocked by**: None | **Status**: DONE

**What to build**:

- Extend `FastTask` with `files_to_delete: list[str] = []` and `constraints: list[str] = []`
- Create `CodingPlanResult` schema in `swe_af/execution/schemas.py`
- Create `swe_af/prompts/coding_planner.py` with `SYSTEM_PROMPT` and `coding_planner_task_prompt()`

**Acceptance criteria**:

- [x] `CodingPlanResult` validates correctly on round-trip serialization
- [x] `FastTask` accepts `files_to_delete` and `constraints` fields without error
- [x] Prompt generates coherent task decomposition from PRD text

---

## Slice 2: plan_coding Reasoner Skeleton

**Type**: AFK | **Blocked by**: Slice 1 | **Status**: DONE

**What to build**:

- Add `plan_coding` async reasoner in `swe_af/reasoners/execution_agents.py` — registered on router, accepts `prd_text + repo_path`, returns hardcoded fallback `CodingPlanResult`
- Wire up harness call structure but return stub data until LLM is connected

**Acceptance criteria**:

- [x] Reasoner registered and callable via `app.call("plan_coding", ...)`
- [x] Returns `CodingPlanResult` shape even with stub data
- [x] Errors propagate correctly on invalid input

---

## Slice 3: Full LLM Integration + Dual Registration

**Type**: AFK | **Blocked by**: Slice 2 | **Status**: DONE

**What to build**:

- Connect harness to LLM with structured output
- Register on both `app_router` (swe-planner) and `fast_router` (swe-fast)
- Ensure `fast_execute_tasks` can consume `files_to_delete` and `constraints` from task output

**Acceptance criteria**:

- [x] `plan_coding` produces valid `CodingPlanResult` with real LLM call
- [x] Callable from both swe-planner and swe-fast agents
- [x] Tasks with file constraints flow through `fast_execute_tasks`

---

## Slice 4: GitHub Webhook Label Routing

**Type**: AFK | **Blocked by**: Slice 3 | **Status**: DONE

**What to build**:

- Update issue webhook handler to detect `type:prd` label
- Route to `plan_coding` → `execute` instead of `build()`
- Other labels route to existing fast path

**Acceptance criteria**:

- [x] `type:prd` label → `plan_coding` called, result feeds to `execute`
- [x] No label / other labels → existing behavior unchanged
- [x] Multiple concurrent webhook dispatches handled correctly

---

## Slice 5: Tests

**Type**: AFK | **Blocked by**: Slice 4 | **Status**: DONE

**What to build**:

- Unit tests for schema
- Integration test for `plan_coding` with mock harness
- Webhook routing test with label variations

**Acceptance criteria**:

- [x] Schema round-trip test passes
- [x] `plan_coding` harness call verified with mock
- [x] Webhook routing logic tested with label variations
