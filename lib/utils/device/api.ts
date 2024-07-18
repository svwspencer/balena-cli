/**
 * @license
 * Copyright 2019 Balena Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import * as _ from 'lodash';
import type * as Stream from 'stream';

import { retry } from '../helpers';
import Logger = require('../logger');
import * as ApiErrors from './errors';
import { getBalenaSdk } from '../lazy';
import type { BalenaSDK } from 'balena-sdk';

export interface DeviceResponse {
	[key: string]: any;

	status: 'success' | 'failed';
	message?: string;
}

export interface DeviceInfo {
	deviceType: string;
	arch: string;
}

export interface Status {
	appState: 'applied' | 'applying';
	overallDownloadProgress: null | number;
	containers: Array<{
		status: string;
		serviceName: string;
		appId: number;
		imageId: number;
		serviceId: number;
		containerId: string;
		createdAt: string;
	}>;
	images: Array<{
		name: string;
		appId: number;
		serviceName: string;
		imageId: number;
		dockerImageId: string;
		status: string;
		downloadProgress: null | number;
	}>;
}

const deviceEndpoints = {
	setTargetState: 'v2/local/target-state',
	getTargetState: 'v2/local/target-state',
	getDeviceInformation: 'v2/local/device-info',
	logs: 'v2/local/logs',
	ping: 'ping',
	version: 'v2/version',
	status: 'v2/state/status',
	containerId: 'v2/containerId',
};

export class DeviceAPI {
	private deviceAddress: string;

	public constructor(
		private logger: Logger,
		addr: string,
		port: number = 48484,
	) {
		this.deviceAddress = `http://${addr}:${port}/`;
	}

	// Either return nothing, or throw an error with the info
	public async setTargetState(state: any): Promise<void> {
		const url = this.getUrlForAction('setTargetState');
		return await DeviceAPI.sendRequest(
			{
				method: 'POST',
				url,
				json: true,
				body: state,
			},
			this.logger,
		);
	}

	public async getTargetState(): Promise<any> {
		const url = this.getUrlForAction('getTargetState');

		return await DeviceAPI.sendRequest(
			{
				method: 'GET',
				url,
				json: true,
			},
			this.logger,
		).then((body) => {
			return body.state;
		});
	}

	public async getDeviceInformation(): Promise<DeviceInfo> {
		const url = this.getUrlForAction('getDeviceInformation');

		return await DeviceAPI.sendRequest(
			{
				method: 'GET',
				url,
				json: true,
			},
			this.logger,
		).then((body) => {
			return body.info;
		});
	}

	public async getContainerId(serviceName: string): Promise<string> {
		const url = this.getUrlForAction('containerId');

		const body = await DeviceAPI.sendRequest(
			{
				method: 'GET',
				url,
				json: true,
				qs: {
					serviceName,
				},
			},
			this.logger,
		);

		if (body.status !== 'success') {
			throw new ApiErrors.DeviceAPIError(
				'Non-successful response from supervisor containerId endpoint',
			);
		}
		return body.containerId;
	}

	public async ping(): Promise<void> {
		const url = this.getUrlForAction('ping');

		return await DeviceAPI.sendRequest(
			{
				method: 'GET',
				url,
			},
			this.logger,
		);
	}

	public async getVersion(): Promise<string> {
		const url = this.getUrlForAction('version');

		return await DeviceAPI.sendRequest({
			method: 'GET',
			url,
			json: true,
		}).then((body) => {
			if (body.status !== 'success') {
				throw new ApiErrors.DeviceAPIError(
					'Non-successful response from supervisor version endpoint',
				);
			}

			return body.version;
		});
	}

	public async getStatus(): Promise<Status> {
		const url = this.getUrlForAction('status');

		return await DeviceAPI.sendRequest({
			method: 'GET',
			url,
			json: true,
		}).then((body) => {
			if (body.status !== 'success') {
				throw new ApiErrors.DeviceAPIError(
					'Non-successful response from supervisor status endpoint',
				);
			}

			return _.omit(body, 'status') as Status;
		});
	}

	public async getLogStream(): Promise<Stream.Readable> {
		const url = this.getUrlForAction('logs');
		const sdk = getBalenaSdk();

		return sdk.request.stream({ url });
		// Don't use the promisified version here as we want to stream the output
		// return new Promise((resolve, reject) => {
		// 	const stream = got.stream.get(url, { throwHttpErrors: false });

		// 	// stream
		// 	// .on('data', async () => {
		// 	// 	// if (res.statusCode !== 200) {
		// 	// 	// 	reject(
		// 	// 	// 		new ApiErrors.DeviceAPIError(
		// 	// 	// 			'Non-200 response from log streaming endpoint',
		// 	// 	// 		),
		// 	// 	// 	);
		// 	// 	// 	return;
		// 	// 	// }
		// 	// 	// try {
		// 	// 	// 	stream.socket.setKeepAlive(true, 1000);
		// 	// 	// } catch (error) {
		// 	// 	// 	reject(error);
		// 	// 	// }
		// 	// });
		// 	resolve(stream);
		// });
	}

	private getUrlForAction(action: keyof typeof deviceEndpoints): string {
		return `${this.deviceAddress}${deviceEndpoints[action]}`;
	}

	// A helper method for promisifying general (non-streaming) requests. Streaming
	// requests should use a seperate setup
	private static async sendRequest(
		opts: Parameters<BalenaSDK['request']['send']>[number],
		logger?: Logger,
	): Promise<any> {
		if (logger != null && opts.url != null) {
			logger.logDebug(`Sending request to ${opts.url}`);
		}

		const sdk = getBalenaSdk();

		const doRequest = async () => {
			const response = await sdk.request.send(opts);

			const bodyError =
				typeof response.body === 'string'
					? response.body
					: response.body.message;
			switch (response.statusCode) {
				case 200:
					return response.body;
				case 400:
					throw new ApiErrors.BadRequestDeviceAPIError(bodyError);
				case 503:
					throw new ApiErrors.ServiceUnavailableAPIError(bodyError);
				default:
					new ApiErrors.DeviceAPIError(bodyError);
			}
		};

		return await retry({
			func: doRequest,
			initialDelayMs: 2000,
			maxAttempts: 6,
			label: `Supervisor API (${opts.method} ${(opts as any).url})`,
		});
	}
}

export default DeviceAPI;
