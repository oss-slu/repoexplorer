import {
    ClassificationEvaluationCliHelpRequested,
    runClassificationEvaluationCli,
} from './classificationEvaluationCli';

try {
    const exitCode = await runClassificationEvaluationCli(process.argv.slice(2));
    process.exitCode = exitCode;
} catch (error) {
    if (error instanceof ClassificationEvaluationCliHelpRequested) {
        process.stdout.write(`${error.message}\n`);
        process.exitCode = 0;
    } else {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`Classification evaluation failed: ${message}\n`);
        process.exitCode = 1;
    }
}
