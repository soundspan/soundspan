#!/usr/bin/env python3

import argparse
import json
import os
import subprocess
import sys
from collections import defaultdict


ROOT_KIND = "feature"
STREAM_KIND = "feature_stream"
STAGE_TASKS = {
    "stage:spec-outline": "spec_outline",
    "stage:refined-spec": "refined_spec",
    "stage:implementation-plan": "implementation_plan",
}
LEAF_TASK_EXEMPT_KEYS = {"verify:tests", "review:cross-llm"}


def trimmed(value):
    return value.strip() if isinstance(value, str) else ""


def normalized_list(value):
    if not isinstance(value, list):
        return []
    output = []
    for item in value:
        item_value = trimmed(item)
        if item_value:
            output.append(item_value)
    return output


def parse_args():
    parser = argparse.ArgumentParser(
        description="Validate soundspan's repo-local ACM feature plan convention."
    )
    parser.add_argument(
        "--project",
        default=os.environ.get("ACM_PROJECT_ID", "soundspan"),
        help="ACM project id (defaults to ACM_PROJECT_ID or soundspan).",
    )
    parser.add_argument(
        "--plan-key",
        default=os.environ.get("ACM_PLAN_KEY", ""),
        help="Plan key to validate (defaults to ACM_PLAN_KEY).",
    )
    parser.add_argument(
        "--receipt-id",
        default=os.environ.get("ACM_RECEIPT_ID", ""),
        help="Receipt id to derive plan:<receipt_id> when --plan-key is omitted.",
    )
    return parser.parse_args()


def fail(message):
    print(f"acm-feature-plan-validate: {message}", file=sys.stderr)
    return 1


def fetch_plan(project, plan_key):
    env = os.environ.copy()
    env["ACM_LOG_SINK"] = "discard"
    command = ["acm", "fetch", "--project", project, "--key", plan_key]
    result = subprocess.run(command, capture_output=True, text=True, env=env)
    if result.returncode != 0:
        raise RuntimeError(
            f"acm fetch failed for {plan_key}: {trimmed(result.stderr) or trimmed(result.stdout) or 'unknown error'}"
        )
    try:
        envelope = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"acm fetch returned invalid JSON for {plan_key}: {exc}") from exc
    items = envelope.get("result", {}).get("items", [])
    if len(items) != 1:
        raise RuntimeError(f"expected one fetched item for {plan_key}, got {len(items)}")
    content = trimmed(items[0].get("content"))
    if not content:
        raise RuntimeError(f"fetched plan {plan_key} had empty content")
    try:
        plan = json.loads(content)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"plan content for {plan_key} was not valid JSON: {exc}") from exc
    if not isinstance(plan, dict):
        raise RuntimeError(f"plan content for {plan_key} was not an object")
    plan["__plan_key"] = plan_key
    return plan


def build_chain(project, starting_plan):
    chain = [starting_plan]
    seen = {starting_plan["__plan_key"]}
    current = starting_plan
    while trimmed(current.get("parent_plan_key")):
        parent_key = trimmed(current.get("parent_plan_key"))
        if parent_key in seen:
            raise RuntimeError(f"cycle detected in plan hierarchy at {parent_key}")
        parent = fetch_plan(project, parent_key)
        chain.append(parent)
        seen.add(parent_key)
        current = parent
    chain.reverse()
    return chain


def require_non_empty_string(plan, field_name, errors):
    value = trimmed(plan.get(field_name))
    if not value:
        errors.append(f"{plan['__plan_key']}: missing non-empty {field_name}")


def require_non_empty_list(plan, field_name, errors):
    if not normalized_list(plan.get(field_name)):
        errors.append(f"{plan['__plan_key']}: {field_name} must contain at least one item")


def index_tasks(plan, errors):
    raw_tasks = plan.get("tasks")
    if not isinstance(raw_tasks, list) or not raw_tasks:
        errors.append(f"{plan['__plan_key']}: tasks must contain at least one task")
        return {}, defaultdict(list)

    tasks_by_key = {}
    children_by_parent = defaultdict(list)

    for index, task in enumerate(raw_tasks):
        if not isinstance(task, dict):
            errors.append(f"{plan['__plan_key']}: task[{index}] must be an object")
            continue
        task_key = trimmed(task.get("key"))
        if not task_key:
            errors.append(f"{plan['__plan_key']}: task[{index}] is missing key")
            continue
        if task_key in tasks_by_key:
            errors.append(f"{plan['__plan_key']}: duplicate task key {task_key}")
            continue
        tasks_by_key[task_key] = task

    for task_key, task in tasks_by_key.items():
        if not trimmed(task.get("summary")):
            errors.append(f"{plan['__plan_key']}: task {task_key} is missing summary")
        parent_task_key = trimmed(task.get("parent_task_key"))
        if parent_task_key:
            if parent_task_key not in tasks_by_key:
                errors.append(
                    f"{plan['__plan_key']}: task {task_key} references unknown parent_task_key {parent_task_key}"
                )
            else:
                children_by_parent[parent_task_key].append(task_key)
        for dependency in normalized_list(task.get("depends_on")):
            if dependency not in tasks_by_key:
                errors.append(
                    f"{plan['__plan_key']}: task {task_key} depends on unknown task {dependency}"
                )

    return tasks_by_key, children_by_parent


def validate_leaf_acceptance(plan, tasks_by_key, children_by_parent, errors):
    found_leaf = False
    for task_key, task in tasks_by_key.items():
        if task_key in STAGE_TASKS:
            continue
        if task_key in children_by_parent:
            continue
        if task_key in LEAF_TASK_EXEMPT_KEYS:
            continue
        found_leaf = True
        if not normalized_list(task.get("acceptance_criteria")):
            errors.append(
                f"{plan['__plan_key']}: leaf task {task_key} must include acceptance_criteria"
            )
    if not found_leaf:
        errors.append(f"{plan['__plan_key']}: expected at least one non-gate leaf task")


def validate_root_feature_plan(plan, errors):
    if trimmed(plan.get("parent_plan_key")):
        errors.append(f"{plan['__plan_key']}: root feature plans must not set parent_plan_key")

    require_non_empty_string(plan, "title", errors)
    require_non_empty_string(plan, "objective", errors)
    require_non_empty_list(plan, "in_scope", errors)
    require_non_empty_list(plan, "out_of_scope", errors)
    require_non_empty_list(plan, "constraints", errors)
    require_non_empty_list(plan, "references", errors)

    stages = plan.get("stages")
    if not isinstance(stages, dict):
        stages = {}
        errors.append(f"{plan['__plan_key']}: stages must be present for feature plans")
    for stage_field in STAGE_TASKS.values():
        if not trimmed(stages.get(stage_field)):
            errors.append(f"{plan['__plan_key']}: stages.{stage_field} must be set")

    tasks_by_key, children_by_parent = index_tasks(plan, errors)
    if not tasks_by_key:
        return

    if "verify:tests" not in tasks_by_key:
        errors.append(f"{plan['__plan_key']}: feature plans must include a verify:tests task")

    for task_key, stage_field in STAGE_TASKS.items():
        stage_task = tasks_by_key.get(task_key)
        if not stage_task:
            errors.append(
                f"{plan['__plan_key']}: missing top-level stage task {task_key}"
            )
            continue
        if trimmed(stage_task.get("parent_task_key")):
            errors.append(
                f"{plan['__plan_key']}: stage task {task_key} must not set parent_task_key"
            )
        plan_stage_status = trimmed(stages.get(stage_field))
        task_status = trimmed(stage_task.get("status"))
        if plan_stage_status and task_status and plan_stage_status != task_status:
            errors.append(
                f"{plan['__plan_key']}: stage task {task_key} status {task_status} must match stages.{stage_field}={plan_stage_status}"
            )
        if not children_by_parent.get(task_key):
            errors.append(
                f"{plan['__plan_key']}: stage task {task_key} must own at least one child task"
            )

    validate_leaf_acceptance(plan, tasks_by_key, children_by_parent, errors)


def validate_feature_stream_plan(plan, errors):
    if not trimmed(plan.get("parent_plan_key")):
        errors.append(
            f"{plan['__plan_key']}: feature_stream plans must set parent_plan_key"
        )
    require_non_empty_string(plan, "title", errors)
    require_non_empty_string(plan, "objective", errors)
    require_non_empty_list(plan, "in_scope", errors)
    require_non_empty_list(plan, "out_of_scope", errors)
    require_non_empty_list(plan, "references", errors)

    tasks_by_key, children_by_parent = index_tasks(plan, errors)
    if not tasks_by_key:
        return

    if "verify:tests" not in tasks_by_key:
        errors.append(
            f"{plan['__plan_key']}: feature_stream plans must include a verify:tests task"
        )

    validate_leaf_acceptance(plan, tasks_by_key, children_by_parent, errors)


def validate_feature_hierarchy(chain):
    errors = []
    root_plan = chain[0]
    root_kind = trimmed(root_plan.get("kind"))
    if root_kind != ROOT_KIND:
        errors.append(
            f"{root_plan['__plan_key']}: root plan in a feature hierarchy must use kind={ROOT_KIND}"
        )
        return errors

    validate_root_feature_plan(root_plan, errors)

    for descendant in chain[1:]:
        descendant_kind = trimmed(descendant.get("kind"))
        if descendant_kind != STREAM_KIND:
            errors.append(
                f"{descendant['__plan_key']}: child plans under a feature root must use kind={STREAM_KIND}"
            )
            continue
        validate_feature_stream_plan(descendant, errors)

    return errors


def main():
    args = parse_args()
    plan_key = trimmed(args.plan_key)
    receipt_id = trimmed(args.receipt_id)

    if not plan_key and receipt_id:
        plan_key = f"plan:{receipt_id}"

    if not plan_key:
        print(
            "acm-feature-plan-validate: skip - no ACM_PLAN_KEY or ACM_RECEIPT_ID was provided",
            file=sys.stderr,
        )
        return 0

    try:
        current_plan = fetch_plan(args.project, plan_key)
        chain = build_chain(args.project, current_plan)
    except RuntimeError as exc:
        return fail(str(exc))

    current_kind = trimmed(current_plan.get("kind"))
    root_kind = trimmed(chain[0].get("kind"))
    managed_hierarchy = root_kind == ROOT_KIND or current_kind == STREAM_KIND
    if not managed_hierarchy:
        print(
            f'acm-feature-plan-validate: skip - active plan {plan_key} uses kind "{current_kind or "unspecified"}", not the repo-local feature plan schema'
        )
        return 0

    errors = validate_feature_hierarchy(chain)
    if errors:
        print("acm-feature-plan-validate: feature plan contract failed:", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
        return 1

    chain_text = " -> ".join(plan["__plan_key"] for plan in chain)
    print(
        f"acm-feature-plan-validate: ok - validated feature plan hierarchy {chain_text}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
