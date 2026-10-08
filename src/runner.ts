import { collectProfile, type LookupStatus, type Requester, type RequestTrace } from './collector.js';
import { appendSnapshot, compareProfile, enrichProfile, previousSnapshot } from './insights.js';
import type { ValidatedInput } from './input.js';
import type { MonitorSession } from './monitor.js';
import type { ProfileRecord } from './types.js';

export interface Dependencies {
    request: Requester;
    newProxy(): Promise<string | undefined>;
    stopped(): boolean;
    canSave(): boolean;
    save(profile: ProfileRecord): Promise<{ saved: boolean; exhausted: boolean }>;
    report(summary: RunSummary): Promise<void>;
    monitor?: MonitorSession;
}
export interface RunSummary {
    status: 'COMPLETE' | 'PARTIAL' | 'BUDGET_LIMIT' | 'TIME_LIMIT' | 'FAILED';
    requested: number;
    saved: number;
    requests: number;
    invalidInputs: number;
    duplicatesRemoved: number;
    historyCommitted: boolean | 'unknown';
    lookups: { username: string; status: LookupStatus; attempts: number; requests: number; traces: RequestTrace[] }[];
    changes: { username: string; profileUrl: string; observedAt: string; changes: ProfileRecord['changes'] }[];
}

export async function runProfiles(input: ValidatedInput, dep: Dependencies): Promise<RunSummary> {
    const summary: RunSummary = { status: 'COMPLETE', requested: input.usernames.length, saved: 0, requests: 0,
        invalidInputs: input.invalidInputs, duplicatesRemoved: input.duplicatesRemoved, historyCommitted: false, lookups: [], changes: [] };
    let fatal: unknown;
    let consecutiveBlocks = 0;
    let lastReported: string | undefined;
    const reportIfChanged = async (): Promise<void> => {
        const snapshot = JSON.stringify(summary);
        if (snapshot === lastReported) return;
        await dep.report(summary);
        // Only suppress a write after its previous attempt succeeded.
        lastReported = snapshot;
    };
    try {
        for (const [index, username] of input.usernames.entries()) {
            const stop = dep.stopped() ? 'TIME_LIMIT' : summary.status === 'BUDGET_LIMIT' || !dep.canSave() ? 'BUDGET_LIMIT' : null;
            if (stop) {
                summary.status = stop;
                summary.lookups.push(...input.usernames.slice(index).map(name => ({ username: name, status: stop as LookupStatus, attempts: 0, requests: 0, traces: [] })));
                break;
            }
            await dep.monitor?.renew();
            const lookup = await collectProfile(username, dep.request, dep.newProxy, dep.stopped, input.includeRecentPosts);
            summary.requests += lookup.requests;
            const diagnostic = { username, status: lookup.status, attempts: lookup.attempts, requests: lookup.requests, traces: lookup.traces };
            summary.lookups.push(diagnostic);
            if (lookup.status === 'TIME_LIMIT') summary.status = 'TIME_LIMIT';
            consecutiveBlocks = lookup.status === 'BLOCKED' ? consecutiveBlocks + 1 : 0;
            if (consecutiveBlocks >= 2) {
                // Skip, rather than repeatedly paying for an unavailable source across a large roster.
                summary.lookups.push(...input.usernames.slice(index + 1).map(name => ({ username: name,
                    status: 'SOURCE_BLOCKED' as const, attempts: 0, requests: 0, traces: [] })));
                break;
            }
            if (!lookup.result) continue;
            const profile = enrichProfile(lookup.result, input.includeRecentPosts, input.maxRecentPosts);
            if (dep.monitor) profile.changes = compareProfile(profile, previousSnapshot(dep.monitor.state, username, profile.scrapedAt), input.followerChangeThresholdPercent);
            if (!dep.canSave()) {
                diagnostic.status = 'BUDGET_LIMIT';
                summary.status = 'BUDGET_LIMIT';
                continue;
            }
            let saved: { saved: boolean; exhausted: boolean };
            try { saved = await dep.save(profile); }
            catch (error) { diagnostic.status = 'STORAGE_ERROR'; throw error; }
            if (saved.saved) {
                summary.saved++;
                if (dep.monitor && !profile.changes?.reasons.includes('NON_FORWARD_OBSERVATION')) appendSnapshot(dep.monitor.state, profile);
                if (profile.changes?.status === 'CHANGED') summary.changes.push({ username, profileUrl: profile.profileUrl, observedAt: profile.scrapedAt, changes: profile.changes });
            } else diagnostic.status = 'BUDGET_LIMIT';
            // Exhausting the allowance after saving every requested profile is completion,
            // not a truncated run. Still stop if any requested work remains unsaved.
            if (saved.exhausted && summary.saved < summary.requested) summary.status = 'BUDGET_LIMIT';
        }
        if (summary.status === 'COMPLETE' && summary.saved < summary.requested) summary.status = 'PARTIAL';
        if (!summary.saved && !['BUDGET_LIMIT', 'TIME_LIMIT'].includes(summary.status)) {
            summary.status = 'FAILED';
            throw new Error('No confirmed public profiles were saved. See OUTPUT for blocked, private, unavailable or incomplete lookups.');
        }
        // Save the report before advancing the baseline; a failed export cannot silently consume a change.
        await reportIfChanged();
        if (dep.monitor && summary.saved) {
            summary.historyCommitted = 'unknown';
            await dep.monitor.commit();
            summary.historyCommitted = true;
        }
    } catch (error) {
        fatal = error;
        summary.status = 'FAILED';
    } finally {
        try { await dep.monitor?.release(); } catch (error) { fatal ??= error; summary.status = 'FAILED'; }
        try { await reportIfChanged(); } catch (error) { fatal ??= error; }
    }
    if (fatal) throw fatal;
    return summary;
}
