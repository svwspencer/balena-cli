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

import { IArg } from '@oclif/parser/lib/args';
import Command from '../../command';
import { stripIndent } from '../../utils/lazy';
import {
	applicationIdInfo,
} from '../../utils/messages';

import * as fs from 'fs'
import * as fetch from 'isomorphic-fetch'
import * as cf from '../../utils/common-flags';
import { flags } from '@oclif/command';
import { uniqueNamesGenerator, adjectives, colors, animals } from 'unique-names-generator'

function randomName() {
	return uniqueNamesGenerator({
		dictionaries: [adjectives, colors, animals],
		separator: '-'
	})
}

interface FlagsDef {
	help: void;
	v13: boolean;
	apiKey?: string;
	region?: string;
	size?: string;
	imageName?: string;
}

export default class InstanceInitCmd extends Command {
	public static description = stripIndent`
		Initialize an instance with balenaOS.

		Initialize a device by downloading the OS image of the specified fleet
		and writing it to an SD Card.

		If the --fleet option is omitted, it will be prompted for interactively.

		${applicationIdInfo.split('\n').join('\n\t\t')}
	`;

	public static examples = [
		'$ balena instance init',
		'$ balena instance init --fleet MyFleet',
		'$ balena instance init -f myorg/myfleet',
	];

	public static usage = 'instance init';

	public static args: Array<IArg<any>> = [
		{
			name: 'configFile',
			description: 'the config.json file path',
			required: true,
		},
	];

	public static flags: flags.Input<FlagsDef> = {
		help: cf.help,
		v13: cf.v13,
		apiKey: flags.string({
			description: 'DigitalOcean api key',
		}),
		region: flags.string({
			description: 'DigitalOcean region',
		}),
		size: flags.string({
			description: 'DigitalOcean droplet size',
		}),
		imageName: flags.string({
			description: 'custom image name',
		})
	};

	public static authenticated = true;

	public async run() {
		const { args: params, flags: options } = this.parse<FlagsDef, { configFile: string }>(InstanceInitCmd);

		// Check if the config file exists
		console.log('Reading config file')
		const exists = fs.existsSync(params.configFile)
		if (!exists) {
			console.log('Config file does not exist, exiting...')
			return
		}

		const configFile = JSON.parse(fs.readFileSync(params.configFile).toString())

		console.log('Checking if image already exists...')

		const imageName = options.imageName || 'balenaOS-qemux86-64'
		let skipUpload = false
		let imageID = 0
		let page = 1

		let res
		let responseBody
		let images = []

		do {
			res = await fetch(`https://api.digitalocean.com/v2/images?per_page=200&page=${page}`, {
				headers: {
					authorization: `Bearer ${options.apiKey}`
				}
			})
			responseBody = await res.json()
			console.log(responseBody.images.length)
			for (const image of responseBody.images) {
				if (image.name === imageName) {
					console.log('Image already exists, skipping upload.')
					skipUpload = true
					imageID = image.id
					break
				}
			}
			page++
			images = responseBody.images
		} while (images.length === 200)

		if (!skipUpload) {
			console.log('Existing image with same name not found, creating digitalocean image...')

			if (!options.apiKey) {
				console.log('Missing digitalocean api key, please provide with --apiKey <api_key>')
			}

			console.log('Uploading image...')
			res = await fetch('https://api.digitalocean.com/v2/images', {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					authorization: `Bearer ${options.apiKey}`
				},
				body: JSON.stringify({
					name: imageName,
					url: `https://api.balena-cloud.com/download?fileType=.gz&appId=1833771&deviceType=qemux86-64`,
					distribution: 'Unknown',
					region: 'nyc1',
					description: 'balenaOS custom image',
					tags: [
						'balenaOS'
					]
				})
			})
			console.log('Image sent.')

			responseBody = await res.json()
			imageID = responseBody.image.id
			do {
				console.log('Waiting for image to be ready...')
				await new Promise((r) => setTimeout(() => r(null), 2000)) // Sleep for 2 seconds
				res = await fetch(`https://api.digitalocean.com/v2/images/${imageID}`, {
					headers: {
						authorization: `Bearer ${options.apiKey}`
					}
				})
				responseBody = await res.json()
			} while (responseBody.image.status !== 'available')
			console.log('Image available.')
		}

		console.log('Getting ssh key info')
		res = await fetch('https://api.digitalocean.com/v2/account/keys', {
			headers: {
				authorization: `Bearer ${options.apiKey}`
			}
		})
		responseBody = await res.json()

		const sshKeyID = responseBody.ssh_keys[0].id
		const randomDropletID = randomName()

		console.log('Creating droplet...')
		res = await fetch('https://api.digitalocean.com/v2/droplets', {
			method: 'POST',
			body: JSON.stringify({
				name: randomDropletID,
				region: options.region || 'nyc1',
				size: options.size || 's-2vcpu-4gb',
				image: imageID,
				ssh_keys: [sshKeyID],
				user_data: JSON.stringify(configFile),
				tags: [
					'balenaOS'
				]
			}),
			headers: {
				authorization: `Bearer ${options.apiKey}`,
				'content-type': 'application/json'
			}
		})

		responseBody = await res.json()
		const createURL = responseBody.links.actions.filter((action: any) => action.rel === 'create')[0]
		if (!createURL) {
			console.error('Failed to get a create check url! You will probably want to cleanup the image and droplet in your dashboard.')
			return
		}

		do {
			console.log('Wait for droplet to be created...')
			await new Promise((r) => setTimeout(() => r(null), 2000)) // Sleep for 2 seconds
			res = await fetch(createURL.href, {
				headers: {
					authorization: `Bearer ${options.apiKey}`
				}
			})
			responseBody = await res.json()
		} while (responseBody.action.status !== 'completed')

		console.log('Done! the device should show soon!')

	}
}
