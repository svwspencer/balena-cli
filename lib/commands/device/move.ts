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

import type { flags } from '@oclif/command';
import type { IArg } from '@oclif/parser/lib/args';
import type { Application, BalenaSDK } from 'balena-sdk';
import Command from '../../command';
import * as cf from '../../utils/common-flags';
import { ExpectedError } from '../../errors';
import { getBalenaSdk, stripIndent } from '../../utils/lazy';
import {
	applicationIdInfo,
	appToFleetFlagMsg,
	warnify,
} from '../../utils/messages';
import { isV13 } from '../../utils/version';

interface ExtendedDevice extends DeviceWithDeviceType {
	application_name?: string;
}

interface FlagsDef {
	application?: string;
	app?: string;
	fleet?: string;
	help: void;
}

interface ArgsDef {
	uuid: string;
}

export default class DeviceMoveCmd extends Command {
	public static description = stripIndent`
		Move one or more devices to another fleet.

		Move one or more devices to another fleet.

		If --fleet is omitted, the fleet will be prompted for interactively.

		${applicationIdInfo.split('\n').join('\n\t\t')}
	`;

	public static examples = [
		'$ balena device move 7cf02a6',
		'$ balena device move 7cf02a6,dc39e52',
		'$ balena device move 7cf02a6 --fleet MyNewFleet',
		'$ balena device move 7cf02a6 -f myorg/mynewfleet',
	];

	public static args: Array<IArg<any>> = [
		{
			name: 'uuid',
			description:
				'comma-separated list (no blank spaces) of device UUIDs to be moved',
			required: true,
		},
	];

	public static usage = 'device move <uuid(s)>';

	public static flags: flags.Input<FlagsDef> = {
		...(isV13() ? {} : { app: cf.app, application: cf.application }),
		fleet: cf.fleet,
		help: cf.help,
	};

	public static authenticated = true;

	public async run() {
		const { args: params, flags: options } = this.parse<FlagsDef, ArgsDef>(
			DeviceMoveCmd,
		);

		if ((options.application || options.app) && process.stderr.isTTY) {
			console.error(warnify(appToFleetFlagMsg));
		}
		options.application ||= options.app || options.fleet;

		const balena = getBalenaSdk();

		const { tryAsInteger } = await import('../../utils/validation');
		const { expandForAppName } = await import('../../utils/helpers');

		// Parse ids string into array of correct types
		const deviceIds: Array<string | number> = params.uuid
			.split(',')
			.map((id) => tryAsInteger(id));

		// Get devices
		const devices = await Promise.all(
			deviceIds.map(
				(uuid) =>
					balena.models.device.get(
						uuid,
						expandForAppName,
					) as Promise<ExtendedDevice>,
			),
		);

		// Map application name for each device
		for (const device of devices) {
			const belongsToApplication =
				device.belongs_to__application as Application[];
			device.application_name = belongsToApplication?.[0]
				? belongsToApplication[0].app_name
				: 'N/a';
		}

		// Disambiguate application (if is a number, it could either be an ID or a numerical name)
		const { getApplication } = await import('../../utils/sdk');

		// Get destination application
		const application = options.application
			? await getApplication(balena, options.application)
			: await this.interactivelySelectApplication(balena, devices);

		// Move each device
		for (const uuid of deviceIds) {
			try {
				await balena.models.device.move(uuid, application.id);
				console.info(`Device ${uuid} was moved to fleet ${application.slug}`);
			} catch (err) {
				console.info(`${err.message}, uuid: ${uuid}`);
				process.exitCode = 1;
			}
		}
	}

	async interactivelySelectApplication(
		balena: BalenaSDK,
		devices: ExtendedDevice[],
	) {
		const { getExpandedProp } = await import('../../utils/pine');
		const [deviceDeviceTypes, deviceTypes] = await Promise.all([
			balena.models.deviceType.getAll({
				$select: 'slug',
				$expand: {
					is_of__cpu_architecture: {
						$select: 'slug',
					},
				},
				$filter: {
					slug: {
						// deduplicate the device type slugs
						$in: Array.from(
							new Set(
								devices.map((device) => device.is_of__device_type[0].slug),
							),
						),
					},
				},
			}),
			balena.models.deviceType.getAllSupported({
				$select: 'slug',
				$expand: {
					is_of__cpu_architecture: {
						$select: 'slug',
					},
				},
			}),
		]);

		const compatibleDeviceTypes = deviceTypes.filter((dt) => {
			const dtArch = getExpandedProp(dt.is_of__cpu_architecture, 'slug')!;
			return deviceDeviceTypes.every((deviceDeviceType) =>
				balena.models.os.isArchitectureCompatibleWith(
					getExpandedProp(deviceDeviceType.is_of__cpu_architecture, 'slug')!,
					dtArch,
				),
			);
		});

		const patterns = await import('../../utils/patterns');
		try {
			const application = await patterns.selectApplication(
				(app) =>
					compatibleDeviceTypes.some(
						(dt) => dt.slug === app.is_for__device_type[0].slug,
					) &&
					devices.some((device) => device.application_name !== app.app_name),
				true,
			);
			return application;
		} catch (err) {
			if (deviceDeviceTypes.length) {
				throw new ExpectedError(
					`${err.message}\nDo all devices have a compatible architecture?`,
				);
			}
			throw err;
		}
	}
}
