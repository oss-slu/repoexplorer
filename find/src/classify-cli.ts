import {
    ClassificationCliHelpRequested,
    runClassificationCli,
} from './classificationCli';

try {
    const exitCode = await runClassificationCli(process.argv.slice(2));
    process.exitCode = exitCode;
} catch (error) {
    if (error instanceof ClassificationCliHelpRequested) {
        process.stdout.write(`${error.message}\n`);
        process.exitCode = 0;
    } else {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`Classification failed: ${message}\n`);
        process.exitCode = 1;
    }
}
