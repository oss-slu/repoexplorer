import { jest } from '@jest/globals';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runClassificationEvaluationCli } from '../classificationEvaluationCli';

type ChatRequest = {
    model: string;
    messages: Array<{ role: string; content: string }>;
    response_format?: { json_schema?: { name?: string; strict?: boolean } };
    [field: string]: unknown;
};

/**
 * A stand-in for a local Ollama server: it answers chat completions the way a
 * well-behaved model would, choosing evidence IDs from the catalog in the
 * prompt. Affiliation is supported for both repositories, but only one quote
 * names the institution, so the evidence gate has something to downgrade.
 */
function startModelServer() {
    const requests: ChatRequest[] = [];
    const server = createServer((request, response) => {
        let body = '';
        request.on('data', (chunk) => (body += chunk));
        request.on('end', () => {
            try {
                const chat = JSON.parse(body) as ChatRequest;
                requests.push(chat);
                const prompt = chat.messages
                    .map((message) => message.content)
                    .join('\n');
                const catalog = [
                    ...prompt.matchAll(
                        /"id":\s*"(E\d{4})",\s*"field":\s*"\w+",\s*"text":\s*"([^"]*)"/g,
                    ),
                ].map(([, id, text]) => ({ id: id!, text: text! }));
                const named = catalog.find((entry) =>
                    entry.text.includes('Alpha Test University'),
                );
                const reply =
                    chat.response_format?.json_schema?.name ===
                    'repository_project_type'
                        ? {
                              category: 'EDU',
                              evidenceIds: [catalog[0]!.id],
                              explanation: 'Coursework.',
                          }
                        : {
                              decision: 'supported',
                              relationship: 'coursework',
                              score: 0.9,
                              evidenceIds: [(named ?? catalog[0]!).id],
                              explanation:
                                  'The repository is a course project.',
                          };
                response.setHeader('content-type', 'application/json');
                response.end(
                    JSON.stringify({
                        choices: [
                            {
                                message: { content: JSON.stringify(reply) },
                                finish_reason: 'stop',
                            },
                        ],
                        usage: {
                            prompt_tokens: 100,
                            completion_tokens: 20,
                            total_tokens: 120,
                        },
                    }),
                );
            } catch (error) {
                response.statusCode = 500;
                response.end(String(error));
            }
        });
    });
    return new Promise<{
        url: string;
        requests: ChatRequest[];
        close: () => Promise<void>;
    }>((resolve) =>
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address() as AddressInfo;
            resolve({
                url: `http://127.0.0.1:${port}/v1`,
                requests,
                close: () =>
                    new Promise((done) => {
                        server.closeAllConnections();
                        server.close(() => done());
                    }),
            });
        }),
    );
}

function fixture(caseId: string, readme: string, affiliation: string) {
    return {
        caseId,
        snapshotAt: '2026-11-24T00:00:00.000Z',
        institution: {
            key: 'Alpha Test University',
            fullName: 'Alpha Test University',
            acronym: 'ATU',
        },
        candidate: {
            id: caseId.length,
            fullName: `someone/${caseId}`,
            owner: 'someone',
            description: 'A course project',
            readme,
            homepage: null,
            language: 'TypeScript',
            license: 'mit',
            fork: 0,
            size: 12,
            stargazersCount: 0,
            forksCount: 0,
            archived: false,
            isTemplate: false,
        },
        labelProvenance: 'independent_human',
        labels: { affiliation, projectType: 'EDU' },
        labelRationale: '',
        split: 'held_out',
    };
}

test('evaluation CLI end to end against a local OpenAI-compatible server with the example config', async () => {
    const server = await startModelServer();
    const directory = await mkdtemp(path.join(os.tmpdir(), 'evaluate-e2e-'));
    const stdout = jest
        .spyOn(process.stdout, 'write')
        .mockImplementation(() => true);
    try {
        const example = JSON.parse(
            await readFile('config/evaluation.example.json', 'utf8'),
        ) as Record<string, unknown>;
        const configPath = path.join(directory, 'config.json');
        await writeFile(
            configPath,
            JSON.stringify({
                ...example,
                baseUrl: server.url,
                timeoutMs: 5000,
                maxRetries: 0,
            }),
        );
        const fixturesPath = path.join(directory, 'fixtures.json');
        await writeFile(
            fixturesPath,
            JSON.stringify({
                cases: [
                    fixture(
                        'named',
                        'CS 101 starter code at Alpha Test University.',
                        'supported',
                    ),
                    fixture(
                        'unnamed',
                        'A general-purpose parsing library.',
                        'not_supported',
                    ),
                ],
            }),
        );
        const outputPath = path.join(directory, 'report.json');

        const exitCode = await runClassificationEvaluationCli([
            '--fixtures',
            fixturesPath,
            '--config',
            configPath,
            '--output',
            outputPath,
        ]);

        expect(exitCode).toBe(0);
        expect(String(stdout.mock.calls[0]?.[0])).toMatch(
            /^Evaluation completed: 2\/2 cases/,
        );
        // The report holds raw replies and inputs, so only the owner may read it.
        expect((await stat(outputPath)).mode & 0o777).toBe(0o600);

        // The client sent the example config's model and generation settings.
        expect(server.requests).toHaveLength(4);
        for (const request of server.requests) {
            expect(request).toMatchObject({
                model: example.model,
                temperature: 0,
                max_tokens: 512,
                reasoning_effort: 'none',
                response_format: { json_schema: { strict: true } },
            });
        }

        const report = JSON.parse(await readFile(outputPath, 'utf8'));
        expect(report).toMatchObject({
            caseCount: 2,
            citationMode: 'evidence_id',
            providerResults: {
                logicalRequests: 4,
                success: 4,
                evidenceReferencesValid: { valid: 4, denominator: 4 },
                contractValid: { valid: 4, denominator: 4 },
            },
            affiliationEvidenceGate: {
                rawSupported: 2,
                gatedSupported: 1,
                downgraded: 1,
            },
            productionPipeline: { followUpRequests: 0 },
        });
        const named = report.cases.find(
            (result: { caseId: string }) => result.caseId === 'named',
        );
        expect(named.affiliation.response.evidence[0].quote).toContain(
            'Alpha Test University',
        );
        expect(
            report.affiliationMetrics.held_out.confusion.not_supported
                .supported,
        ).toBe(1);
        expect(
            report.affiliationEvidenceGate.metrics.held_out.confusion.supported
                .supported,
        ).toBe(1);
    } finally {
        stdout.mockRestore();
        await server.close();
        await rm(directory, { recursive: true, force: true });
    }
});
