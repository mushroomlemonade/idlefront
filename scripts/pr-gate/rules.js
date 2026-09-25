import { APPROVED_ISSUE_LABEL, LABELS, SMALL_FIX_LINE_THRESHOLD, TRUSTED_BOT_AUTHORS, TRUSTED_REPO_PERMISSIONS, } from "./config";
const LINKED_ISSUE_RE = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi;
export function parseLinkedIssues(body) {
    if (!body)
        return [];
    const stripped = body
        .replace(/```[\s\S]*?```/g, "")
        .replace(/`[^`\n]*`/g, "");
    const result = new Set();
    for (const m of stripped.matchAll(LINKED_ISSUE_RE)) {
        result.add(parseInt(m[1], 10));
    }
    return [...result];
}
export function checkBypass(pr) {
    if (pr.labels.includes(LABELS.BYPASS)) {
        return { action: "pass", reason: `PR has "${LABELS.BYPASS}" label` };
    }
    return { action: "next" };
}
export function checkTrustedBot(pr) {
    if (TRUSTED_BOT_AUTHORS.includes(pr.user.login)) {
        return {
            action: "pass",
            reason: `Author "${pr.user.login}" is a trusted bot`,
        };
    }
    return { action: "next" };
}
export async function checkRepoAccess(pr, getRepoPermission) {
    const permission = await getRepoPermission(pr.user.login);
    if (TRUSTED_REPO_PERMISSIONS.includes(permission)) {
        return {
            action: "pass",
            reason: `Author has "${permission}" permission on the repo`,
        };
    }
    return { action: "next" };
}
export async function checkApprovedWork(pr, getIssue) {
    const issueNumbers = parseLinkedIssues(pr.body);
    if (issueNumbers.length === 0)
        return { action: "next" };
    for (const issueNumber of issueNumbers) {
        const issue = await getIssue(issueNumber);
        if (!issue)
            continue;
        if (!issue.labels.includes(APPROVED_ISSUE_LABEL))
            continue;
        const assigneeLogins = issue.assignees.map((a) => a.login);
        if (!assigneeLogins.includes(pr.user.login))
            continue;
        return {
            action: "pass",
            reason: `Linked to #${issueNumber} (labelled "${APPROVED_ISSUE_LABEL}"), author is assigned`,
        };
    }
    return { action: "next" };
}
export function checkSmallFix(files) {
    const totalLines = files.reduce((sum, f) => sum + f.additions + f.deletions, 0);
    if (totalLines <= SMALL_FIX_LINE_THRESHOLD) {
        return {
            action: "pass",
            reason: `Diff is ${totalLines} lines (≤ ${SMALL_FIX_LINE_THRESHOLD})`,
            labelToAdd: LABELS.SMALL_FIX,
        };
    }
    return { action: "next" };
}
export async function evaluate(pr, files, getIssue, getRepoPermission) {
    const r0 = checkBypass(pr);
    if (r0.action !== "next")
        return r0;
    const rBot = checkTrustedBot(pr);
    if (rBot.action !== "next")
        return rBot;
    const r1 = await checkRepoAccess(pr, getRepoPermission);
    if (r1.action !== "next")
        return r1;
    const r2 = await checkApprovedWork(pr, getIssue);
    if (r2.action !== "next")
        return r2;
    const r3 = checkSmallFix(files);
    if (r3.action !== "next")
        return r3;
    const totalLines = files.reduce((sum, f) => sum + f.additions + f.deletions, 0);
    return {
        action: "close",
        reason: `No linked "${APPROVED_ISSUE_LABEL}" issue with author assigned, diff is ${totalLines} lines`,
    };
}
//# sourceMappingURL=rules.js.map