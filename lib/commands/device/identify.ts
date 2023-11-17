/**
 * @license
 * Copyright 2016-2020 Balena Ltd.
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

import { Args } from '@oclif/core';
import Command from '../../command.js';
import * as cf from '../../utils/common-flags.js';
import { getBalenaSdk, stripIndent } from '../../utils/lazy.js';
import { ExpectedError } from '../../errors.js';

export default class DeviceIdentifyCmd extends Command {
	public static description = stripIndent`
		Identify a device.

		Identify a device by making the ACT LED blink (Raspberry Pi).
		`;
	public static examples = ['$ balena device identify 23c73a1'];

	public static args = {
		uuid: Args.string({
			description: 'the uuid of the device to identify',
			required: true,
		}),
	};

	public static usage = 'device identify <uuid>';

	public static flags = {
		help: cf.help,
	};

	public static authenticated = true;

	public async run() {
		const { args: params } = await this.parse(DeviceIdentifyCmd);

		const balena = await getBalenaSdk();

		try {
			await balena.models.device.identify(params.uuid);
		} catch (e) {
			// Expected message: 'Request error: No online device(s) found'
			if (e.message?.toLowerCase().includes('online')) {
				throw new ExpectedError(`Device ${params.uuid} is not online`);
			} else {
				throw e;
			}
		}
	}
}
