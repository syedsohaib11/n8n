import type { User } from '@n8n/db';
import { WorkflowRepository } from '@n8n/db';
import { Command } from '@n8n/decorators';
import { Container } from '@n8n/di';
import fs from 'fs';
import { diff } from 'json-diff';
import pick from 'lodash/pick';
import type { IRun, ITaskData, IWorkflowBase, IWorkflowExecutionDataProcess } from 'n8n-workflow';
import { jsonParse, UnexpectedError } from 'n8n-workflow';
import os from 'os';
import { sep } from 'path';
import { z } from 'zod';

import { ActiveExecutions } from '@/active-executions';
import { OwnershipService } from '@/services/ownership.service';
import { findCliWorkflowStart } from '@/utils';
import { WorkflowRunner } from '@/workflow-runner';

import { BaseCommand } from './base-command';
import config from '../config';
import type {
	IExecutionResult,
	INodeSpecialCase,
	INodeSpecialCases,
	IResult,
	IWorkflowExecutionProgress,
} from '../types/commands.types';

const re = /\d+/;

interface ISkipList {
	workflowId: string;
	status: string;
	skipReason: string;
	ticketReference: string;
}

const flagsSchema = z.object({
	debug: z
		.boolean()
		.describe('Toggles on displaying all errors and debug messages.')
		.default(false),
	ids: z
		.string()
		.describe(
			'Specifies workflow IDs to get executed, separated by a comma or a file containing the ids',
		)
		.optional(),
	concurrency: z
		.number()
		.int()
		.default(1)
		.describe('How many workflows can run in parallel. Defaults to 1 which means no concurrency.'),
	output: z
		.string()
		.describe(
			'Enable execution saving, You must inform an existing folder to save execution via this param',
		)
		.optional(),
	snapshot: z
		.string()
		.describe(
			'Enables snapshot saving. You must inform an existing folder to save snapshots via this param.',
		)
		.optional(),
	compare: z
		.string()
		.describe(
			'Compares current execution with an existing snapshot. You must inform an existing folder where the snapshots are saved.',
		)
		.optional(),
	shallow: z
		.boolean()
		.describe(
			'Compares only if attributes output from node are the same, with no regards to nested JSON objects.',
		)
		.optional(),
	githubWorkflow: z
		.boolean()
		.describe(
			'Enables more lenient comparison for GitHub workflows. This is useful for reducing false positives when comparing Test workflows.',
		)
		.optional(),
	skipList: z
		.string()
		.describe('File containing a comma separated list of workflow IDs to skip.')
		.optional(),
	retries: z
		.number()
		.int()
		.default(1)
		.describe('Retries failed workflows up to N tries. Default is 1. Set 0 to disable.'),
	shortOutput: z
		.boolean()
		.describe('Omits the full execution information from output, displaying only summary.')
		.optional(),
});

@Command({
	name: 'execute-batch',
	description: 'Executes multiple workflows once',
	examples: [
		'',
		'--concurrency=10 --skipList=/data/skipList.json',
		'--debug --output=/data/output.json',
		'--ids=10,13,15 --shortOutput',
		'--snapshot=/data/snapshots --shallow',
		'--compare=/data/previousExecutionData --retries=2',
	],
	flagsSchema,
})
export class ExecuteBatch extends BaseCommand<z.infer<typeof flagsSchema>> {
	static cancelled = false;

	static workflowExecutionsProgress: IWorkflowExecutionProgress[][];

	static shallow = false;

	static compare: string;

	static snapshot: string;

	static concurrency = 1;

	static githubWorkflow = false;

	static debug = false;

	static executionTimeout = 3 * 60 * 1000;

	static instanceOwner: User;

	static aliases = ['executeBatch'];

	override needsCommunityPackages = true;

	override needsTaskRunner = true;

	/**
	 * Gracefully handles exit.
	 * @param {boolean} skipExit Whether to skip exit or number according to received signal
	 */
	async stopProcess(skipExit: boolean | number = false) {
		if (ExecuteBatch.cancelled) {
			process.exit(0);
		}

		ExecuteBatch.cancelled = true;

		await Container.get(ActiveExecutions).shutdown(true);

		// We may receive true but when called from `process.on`
		// we get the signal (SIGINT, etc.)
		if (skipExit !== true) {
			process.exit(0);
		}
	}

	private formatJsonOutput(data: object) {
		return JSON.stringify(data, null, 2);
	}

	private shouldBeConsideredAsWarning(errorMessage: string) {
		const warningStrings = [
			'refresh token is invalid',
			'unable to connect to',
			'econnreset',
			'429',
			'econnrefused',
			'missing a required parameter',
			'insufficient credit balance',
			'internal server error',
			'503',
			'502',
			'504',
			'insufficient balance',
			'request timed out',
			'status code 401',
		];

		errorMessage = errorMessage.toLowerCase();
		for (let i = 0; i < warningStrings.length; i++) {
			if (errorMessage.includes(warningStrings[i])) {
				return true;
			}
		}

		return false;
	}

	async init() {
		await super.init();
		await this.initBinaryDataService();
		await this.initDataDeduplicationService();
		await this.initExternalHooks();
	}

	// eslint-disable-next-line complexity
	async run() {
		const { flags } = this;
		ExecuteBatch.debug = flags.debug;
		ExecuteBatch.concurrency = flags.concurrency || 1;

		const ids: string[] = [];
		const skipIds: string[] = [];

		if (flags.snapshot !== undefined) {
			if (fs.existsSync(flags.snapshot)) {
				if (!fs.lstatSync(flags.snapshot).isDirectory()) {
					this.logger.error('The parameter --snapshot must be an existing directory');
					return;
				}
			} else {
				this.logger.error('The parameter --snapshot must be an existing directory');
				return;
			}

			ExecuteBatch.snapshot = flags.snapshot;
		}
		if (flags.compare !== undefined) {
			if (fs.existsSync(flags.compare)) {
				if (!fs.lstatSync(flags.compare).isDirectory()) {
					this.logger.error('The parameter --compare must be an existing directory');
					return;
				}
			} else {
				this.logger.error('The parameter --compare must be an existing directory');
				return;
			}

			ExecuteBatch.compare = flags.compare;
		}

		if (flags.output !== undefined) {
			if (fs.existsSync(flags.output)) {
				if (fs.lstatSync(flags.output).isDirectory()) {
					this.logger.error('The parameter --output must be a writable file');
					return;
				}
			}
		}

		if (flags.ids !== undefined) {
			if (fs.existsSync(flags.ids)) {
				const contents = fs.readFileSync(flags.ids, { encoding: 'utf-8' });
				ids.push(
					...contents
						.trimEnd()
						.split(',')
						.filter((id) => re.exec(id)),
				);
			} else {
				const paramIds = flags.ids.split(',');
				const matchedIds = paramIds.filter((id) => re.exec(id));

				if (matchedIds.length === 0) {
					this.logger.error(
						'The parameter --ids must be a list of numeric IDs separated by a comma or a file with this content.',
					);
					return;
				}

				ids.push(...matchedIds);
			}
		}

		if (flags.skipList !== undefined) {
			if (fs.existsSync(flags.skipList)) {
				const contents = fs.readFileSync(flags.skipList, { encoding: 'utf-8' });
				try {
					const parsedSkipList = JSON.parse(contents) as ISkipList[];
					parsedSkipList.forEach((item) => {
						skipIds.push(item.workflowId);
					});
				} catch (error) {
					this.logger.error('Skip list file is not a valid JSON. Exiting.');
					return;
				}
			} else {
				this.logger.error('Skip list file not found. Exiting.');
				return;
			}
		}

		if (flags.shallow) {
			ExecuteBatch.shallow = true;
		}

		if (flags.githubWorkflow) {
			ExecuteBatch.githubWorkflow = true;
		}

		ExecuteBatch.instanceOwner = await Container.get(OwnershipService).getInstanceOwner();

		const query = Container.get(WorkflowRepository).createQueryBuilder('workflows');

		if (ids.length > 0) {
			query.andWhere('workflows.id in (:...ids)', { ids });
		}

		if (skipIds.length > 0) {
			query.andWhere('workflows.id not in (:...skipIds)', { skipIds });
		}

		const allWorkflows = (await query.getMany()) as IWorkflowBase[];

		if (ExecuteBatch.debug) {
			process.stdout.write(`Found ${allWorkflows.length} workflows to execute.\n`);
		}

		// Send a shallow copy of allWorkflows so we still have all workflow data.
		const results = await this.runTests([...allWorkflows]);

		let { retries } = flags;

		while (
			retries > 0 &&
			results.summary.warningExecutions + results.summary.failedExecutions > 0 &&
			!ExecuteBatch.cancelled
		) {
			const failedWorkflowIds = results.summary.errors.map((execution) => execution.workflowId);
			failedWorkflowIds.push(...results.summary.warnings.map((execution) => execution.workflowId));

			const newWorkflowList = allWorkflows.filter((workflow) =>
				failedWorkflowIds.includes(workflow.id),
			);

			const retryResults = await this.runTests(newWorkflowList);

			this.mergeResults(results, retryResults);
			// By now, `results` has been updated with the new successful executions.
			retries--;
		}

		if (flags.output !== undefined) {
			fs.writeFileSync(flags.output, this.formatJsonOutput(results));
			this.logger.info('\nExecution finished.');
			this.logger.info('Summary:');
			this.logger.info(`\tSuccess: ${results.summary.successfulExecutions}`);
			this.logger.info(`\tFailures: ${results.summary.failedExecutions}`);
			this.logger.info(`\tWarnings: ${results.summary.warningExecutions}`);
			this.logger.info('\nNodes successfully tested:');
			Object.entries(results.coveredNodes).forEach(([nodeName, nodeCount]) => {
				this.logger.info(`\t${nodeName}: ${nodeCount}`);
			});
			this.logger.info('\nCheck the JSON file for more details.');
		} else if (flags.shortOutput) {
			this.logger.info(
				this.formatJsonOutput({
					...results,
					executions: results.executions.filter(
						(execution) => execution.executionStatus !== 'success',
					),
				}),
			);
		} else {
			this.logger.info(this.formatJsonOutput(results));
		}

		await this.stopProcess(true);

		if (results.summary.failedExecutions > 0) {
			process.exit(1);
		}
	}

	mergeResults(results: IResult, retryResults: IResult) {
		if (retryResults.summary.successfulExecutions === 0) {
			// Nothing to replace.
			return;
		}

		// Find successful executions and replace them on previous result.
		retryResults.executions.forEach((newExecution) => {
			if (newExecution.executionStatus === 'success') {
				// Remove previous execution from list.
				results.executions = results.executions.filter(
					(previousExecutions) => previousExecutions.workflowId !== newExecution.workflowId,
				);

				const errorIndex = results.summary.errors.findIndex(
					(summaryInformation) => summaryInformation.workflowId === newExecution.workflowId,
				);
				if (errorIndex !== -1) {
					// This workflow errored previously. Decrement error count.
					results.summary.failedExecutions--;
					// Remove from the list of errors.
					results.summary.errors.splice(errorIndex, 1);
				}

				const warningIndex = results.summary.warnings.findIndex(
					(summaryInformation) => summaryInformation.workflowId === newExecution.workflowId,
				);
				if (warningIndex !== -1) {
					// This workflow errored previously. Decrement error count.
					results.summary.warningExecutions--;
					// Remove from the list of errors.
					results.summary.warnings.splice(warningIndex, 1);
				}
				// Increment successful executions count and push it to all executions array.
				results.summary.successfulExecutions++;
				results.executions.push(newExecution);
			}
		});
	}

	private async runTests(allWorkflows: IWorkflowBase[]): Promise<IResult> {
		const result: IResult = {
			totalWorkflows: allWorkflows.length,
			slackMessage: '',
			summary: {
				failedExecutions: 0,
				warningExecutions: 0,
				successfulExecutions: 0,
				errors: [],
				warnings: [],
			},
			coveredNodes: {},
			executions: [],
		};

		if (ExecuteBatch.debug) {
			this.initializeLogs();
		}

		return await new Promise(async (res) => {
			const promisesArray = [];
			for (let i = 0; i < ExecuteBatch.concurrency; i++) {
				const promise = new Promise(async (resolve) => {
					let workflow: IWorkflowBase | undefined;
					while (allWorkflows.length > 0) {
						workflow = allWorkflows.shift();
						if (ExecuteBatch.cancelled) {
							process.stdout.write(`Thread ${i + 1} resolving and quitting.`);
							resolve(true);
							break;
						}
						// This if shouldn't be really needed
						// but it's a concurrency precaution.
						if (workflow === undefined) {
							resolve(true);
							return;
						}

						if (ExecuteBatch.debug) {
							ExecuteBatch.workflowExecutionsProgress[i].push({
								workflowId: workflow.id,
								status: 'running',
							});
							this.updateStatus();
						}

						await this.startThread(workflow).then((executionResult) => {
							if (ExecuteBatch.debug) {
								ExecuteBatch.workflowExecutionsProgress[i].pop();
							}
							result.executions.push(executionResult);
							if (executionResult.executionStatus === 'success') {
								if (ExecuteBatch.debug) {
									ExecuteBatch.workflowExecutionsProgress[i].push({
										workflowId: workflow!.id,
										status: 'success',
									});
									this.updateStatus();
								}
								result.summary.successfulExecutions++;
								const nodeNames = Object.keys(executionResult.coveredNodes);

								nodeNames.map((nodeName) => {
									if (result.coveredNodes[nodeName] === undefined) {
										result.coveredNodes[nodeName] = 0;
									}
									result.coveredNodes[nodeName] += executionResult.coveredNodes[nodeName];
								});
							} else if (executionResult.executionStatus === 'warning') {
								result.summary.warningExecutions++;
								result.summary.warnings.push({
									workflowId: executionResult.workflowId,
									error: executionResult.error!,
								});
								if (ExecuteBatch.debug) {
									ExecuteBatch.workflowExecutionsProgress[i].push({
										workflowId: workflow!.id,
										status: 'warning',
									});
									this.updateStatus();
								}
							} else if (executionResult.executionStatus === 'error') {
								result.summary.failedExecutions++;
								result.summary.errors.push({
									workflowId: executionResult.workflowId,
									error: executionResult.error!,
								});
								if (ExecuteBatch.debug) {
									ExecuteBatch.workflowExecutionsProgress[i].push({
										workflowId: workflow!.id,
										status: 'error',
									});
									this.updateStatus();
								}
							} else {
								throw new UnexpectedError('Wrong execution status - cannot proceed');
							}
						});
					}

					resolve(true);
				});

				promisesArray.push(promise);
			}

			await Promise.allSettled(promisesArray);
			if (ExecuteBatch.githubWorkflow) {
				if (result.summary.errors.length < 6) {
					const errorMessage = result.summary.errors.map((error) => {
						return `*${error.workflowId}*: ${error.error}`;
					});
					result.slackMessage = `*${
						result.summary.errors.length
					} Executions errors*. Workflows failing: ${errorMessage.join(' ')} `;
				} else {
					result.slackMessage = `*${result.summary.errors.length} Executions errors*`;
				}
				this.setOutput('slackMessage', JSON.stringify(result.slackMessage));
			}
			res(result);
		});
	}

	setOutput(key: string, value: any) {
		// Temporary hack until we move to the new action.
		const output = process.env.GITHUB_OUTPUT;

		fs.appendFileSync(output as unknown as fs.PathOrFileDescriptor, `${key}=${value}${os.EOL}`);
	}

	updateStatus() {
		if (ExecuteBatch.cancelled) {
			return;
		}

		if (process.stdout.isTTY) {
			process.stdout.moveCursor(0, -ExecuteBatch.concurrency);
			process.stdout.cursorTo(0);
			process.stdout.clearLine(0);
		}

		ExecuteBatch.workflowExecutionsProgress.map((concurrentThread, index) => {
			let message = `${index + 1}: `;
			concurrentThread.map((executionItem, workflowIndex) => {
				let openColor = '\x1b[0m';
				const closeColor = '\x1b[0m';
				switch (executionItem.status) {
					case 'success':
						openColor = '\x1b[32m';
						break;
					case 'error':
						openColor = '\x1b[31m';
						break;
					case 'warning':
						openColor = '\x1b[33m';
						break;
					default:
						break;
				}
				message += `${workflowIndex > 0 ? ', ' : ''}${openColor}${
					executionItem.workflowId
				}${closeColor}`;
			});
			if (process.stdout.isTTY) {
				process.stdout.cursorTo(0);
				process.stdout.clearLine(0);
			}
			process.stdout.write(`${message}\n`);
		});
	}

	initializeLogs() {
		process.stdout.write('**********************************************\n');
		process.stdout.write('              n8n test workflows\n');
		process.stdout.write('**********************************************\n');
		process.stdout.write('\n');
		process.stdout.write('Batch number:\n');
		ExecuteBatch.workflowExecutionsProgress = [];
		for (let i = 0; i < ExecuteBatch.concurrency; i++) {
			ExecuteBatch.workflowExecutionsProgress.push([]);
			process.stdout.write(`${i + 1}: \n`);
		}
	}

	async startThread(workflowData: IWorkflowBase): Promise<IExecutionResult> {
		// This will be the object returned by the promise.
		// It will be updated according to execution progress below.
		const executionResult: IExecutionResult = {
			workflowId: workflowData.id,
			workflowName: workflowData.name,
			executionTime: 0,
			finished: false,
			executionStatus: 'running',
			coveredNodes: {},
		};

		// We have a cool feature here.
		// On each node, on the Settings tab in the node editor you can change
		// the `Notes` field to add special cases for comparison and snapshots.
		// You need to set one configuration per line with the following possible keys:
		// CAP_RESULTS_LENGTH=x where x is a number. Cap the number of rows from this node to x.
		// This means if you set CAP_RESULTS_LENGTH=1 we will have only 1 row in the output
		// IGNORED_PROPERTIES=x,y,z where x, y and z are JSON property names. Removes these
		//    properties from the JSON object (useful for optional properties that can
		//    cause the comparison to detect changes when not true).
		const nodeEdgeCases = {} as INodeSpecialCases;
		workflowData.nodes.forEach((node) => {
			executionResult.coveredNodes[node.type] = (executionResult.coveredNodes[node.type] || 0) + 1;
			if (node.notes !== undefined && node.notes !== '') {
				node.notes.split('\n').forEach((note) => {
					const parts = note.split('=');
					if (parts.length === 2) {
						if (nodeEdgeCases[node.name] === undefined) {
							nodeEdgeCases[node.name] = {} as INodeSpecialCase;
						}
						if (parts[0] === 'CAP_RESULTS_LENGTH') {
							nodeEdgeCases[node.name].capResults = parseInt(parts[1], 10);
						} else if (parts[0] === 'IGNORED_PROPERTIES') {
							nodeEdgeCases[node.name].ignoredProperties = parts[1]
								.split(',')
								.map((property) => property.trim());
						} else if (parts[0] === 'KEEP_ONLY_PROPERTIES') {
							nodeEdgeCases[node.name].keepOnlyProperties = parts[1]
								.split(',')
								.map((property) => property.trim());
						}
					}
				});
			}
		});

		const workflowRunner = Container.get(WorkflowRunner);

		if (config.getEnv('executions.mode') === 'queue') {
			this.logger.warn('`executeBatch` does not support queue mode. Falling back to regular mode.');
			workflowRunner.setExecutionMode('regular');
		}

		return await new Promise(async (resolve) => {
			let gotCancel = false;

			// Timeouts execution after 5 minutes.
			const timeoutTimer = setTimeout(() => {
				gotCancel = true;
				executionResult.error = 'Workflow execution timed out.';
				executionResult.executionStatus = 'warning';
				resolve(executionResult);
			}, ExecuteBatch.executionTimeout);

			try {
				const startingNode = findCliWorkflowStart(workflowData.nodes);

				const runData: IWorkflowExecutionDataProcess = {
					executionMode: 'cli',
					startNodes: [{ name: startingNode.name, sourceData: null }],
					workflowData,
					userId: ExecuteBatch.instanceOwner.id,
				};

				const executionId = await workflowRunner.run(runData);

				const activeExecutions = Container.get(ActiveExecutions);
				const data = await activeExecutions.getPostExecutePromise(executionId);
				if (gotCancel || ExecuteBatch.cancelled) {
					clearTimeout(timeoutTimer);
					// The promise was settled already so we simply ignore.
					return;
				}

				if (data === undefined) {
					executionResult.error = 'Workflow did not return any data.';
					executionResult.executionStatus = 'error';
				} else {
					executionResult.executionTime =
						(Date.parse(data.stoppedAt as unknown as string) -
							Date.parse(data.startedAt as unknown as string)) /
						1000;
					executionResult.finished = data?.finished !== undefined;

					const resultError = data.data.resultData.error;
					if (resultError) {
						executionResult.error = resultError.description || resultError.message;
						if (data.data.resultData.lastNodeExecuted !== undefined) {
							executionResult.error += ` on node ${data.data.resultData.lastNodeExecuted}`;
						}
						executionResult.executionStatus = 'error';

						if (this.shouldBeConsideredAsWarning(executionResult.error || '')) {
							executionResult.executionStatus = 'warning';
						}
					} else {
						if (ExecuteBatch.shallow) {
							// What this does is guarantee that top-level attributes
							// from the JSON are kept and the are the same type.

							// We convert nested JSON objects to a simple {object:true}
							// and we convert nested arrays to ['json array']

							// This reduces the chance of false positives but may
							// result in not detecting deeper changes.
							Object.keys(data.data.resultData.runData).map((nodeName: string) => {
								data.data.resultData.runData[nodeName].map((taskData: ITaskData) => {
									if (taskData.data === undefined) {
										return;
									}
									Object.keys(taskData.data).map((connectionName) => {
										const connection = taskData.data![connectionName];
										connection.map((executionDataArray) => {
											if (executionDataArray === null) {
												return;
											}

											const { capResults, ignoredProperties, keepOnlyProperties } =
												nodeEdgeCases[nodeName] || {};

											if (capResults !== undefined) {
												executionDataArray.splice(capResults);
											}

											executionDataArray.map((executionData) => {
												if (executionData.json === undefined) {
													return;
												}

												if (ignoredProperties !== undefined) {
													ignoredProperties.forEach(
														(ignoredProperty) => delete executionData.json[ignoredProperty],
													);
												}

												let keepOnlyFields = [] as string[];
												if (keepOnlyProperties !== undefined) {
													keepOnlyFields = keepOnlyProperties;
												}

												executionData.json =
													keepOnlyFields.length > 0
														? pick(executionData.json, keepOnlyFields)
														: executionData.json;
												const jsonProperties = executionData.json;

												const nodeOutputAttributes = Object.keys(jsonProperties);
												nodeOutputAttributes.map((attributeName) => {
													if (Array.isArray(jsonProperties[attributeName])) {
														jsonProperties[attributeName] = ['json array'];
													} else if (typeof jsonProperties[attributeName] === 'object') {
														jsonProperties[attributeName] = { object: true };
													}
												});
											});
										});
									});
								});
							});
						} else {
							// If not using shallow comparison then we only treat nodeEdgeCases.
							const specialCases = Object.keys(nodeEdgeCases);

							specialCases.forEach((nodeName) => {
								data.data.resultData.runData[nodeName].map((taskData: ITaskData) => {
									if (taskData.data === undefined) {
										return;
									}
									Object.keys(taskData.data).map((connectionName) => {
										const connection = taskData.data![connectionName];
										connection.map((executionDataArray) => {
											if (executionDataArray === null) {
												return;
											}

											const capResults = nodeEdgeCases[nodeName].capResults;

											if (capResults !== undefined) {
												executionDataArray.splice(capResults);
											}

											if (nodeEdgeCases[nodeName].ignoredProperties !== undefined) {
												executionDataArray.map((executionData) => {
													if (executionData.json === undefined) {
														return;
													}
													nodeEdgeCases[nodeName].ignoredProperties!.forEach(
														(ignoredProperty) => delete executionData.json[ignoredProperty],
													);
												});
											}
										});
									});
								});
							});
						}

						const serializedData = this.formatJsonOutput(data);
						if (ExecuteBatch.compare === undefined) {
							executionResult.executionStatus = 'success';
						} else {
							const fileName = `${
								ExecuteBatch.compare.endsWith(sep)
									? ExecuteBatch.compare
									: ExecuteBatch.compare + sep
							}${workflowData.id}-snapshot.json`;
							if (fs.existsSync(fileName)) {
								const contents = fs.readFileSync(fileName, { encoding: 'utf-8' });
								const expected = jsonParse<IRun>(contents);
								const received = jsonParse<IRun>(serializedData);
								const changes = diff(expected, received, { keysOnly: true }) as object;

								if (changes !== undefined) {
									// If we had only additions with no removals
									// Then we treat as a warning and not an error.
									// To find this, we convert the object to JSON
									// and search for the `__deleted` string
									const changesJson = JSON.stringify(changes);
									if (changesJson.includes('__deleted')) {
										if (ExecuteBatch.githubWorkflow) {
											const deletedChanges = changesJson.match(/__deleted/g) ?? [];
											// we have structural changes. Report them.
											executionResult.error = `Workflow contains ${deletedChanges.length} deleted data.`;
										} else {
											executionResult.error = 'Workflow may contain breaking changes';
										}
										executionResult.changes = changes;
										executionResult.executionStatus = 'error';
									} else {
										executionResult.error =
											'Workflow contains new data that previously did not exist.';
										executionResult.changes = changes;
										executionResult.executionStatus = 'warning';
									}
								} else {
									executionResult.executionStatus = 'success';
								}
							} else {
								executionResult.error = 'Snapshot for not found.';
								executionResult.executionStatus = 'warning';
							}
						}
						// Save snapshots only after comparing - this is to make sure we're updating
						// After comparing to existing version.
						if (ExecuteBatch.snapshot !== undefined) {
							const fileName = `${
								ExecuteBatch.snapshot.endsWith(sep)
									? ExecuteBatch.snapshot
									: ExecuteBatch.snapshot + sep
							}${workflowData.id}-snapshot.json`;
							fs.writeFileSync(fileName, serializedData);
						}
					}
				}
			} catch (e) {
				this.errorReporter.error(e, {
					extra: {
						workflowId: workflowData.id,
					},
				});
				executionResult.error = `Workflow failed to execute: ${(e as Error).message}`;
				executionResult.executionStatus = 'error';
			}
			clearTimeout(timeoutTimer);
			resolve(executionResult);
		});
	}
}
