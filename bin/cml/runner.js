const { join } = require('path');
const { homedir } = require('os');
const fs = require('fs').promises;
const net = require('net');
const kebabcaseKeys = require('kebabcase-keys');
const timestring = require('timestring');
const winston = require('winston');

const CML = require('../../src/cml').default;
const { randid, sleep } = require('../../src/utils');
const tf = require('../../src/terraform');

let cml;
let RUNNER;
let RUNNER_SHUTTING_DOWN = false;
let RUNNER_TIMER = 0;
const RUNNER_JOBS_RUNNING = [];
const GH_5_MIN_TIMEOUT = (35 * 24 * 60 - 5) * 60 * 1000;

const shutdown = async (opts) => {
  if (RUNNER_SHUTTING_DOWN) return;
  RUNNER_SHUTTING_DOWN = true;

  const { error, cloud } = opts;
  const {
    name,
    workdir = '',
    tfResource,
    noRetry,
    reason,
    destroyDelay
  } = opts;
  const tfPath = workdir;

  const unregisterRunner = async () => {
    if (!RUNNER) return;

    try {
      winston.info(`Unregistering runner ${name}...`);
      await cml.unregisterRunner({ name });
      RUNNER && RUNNER.kill('SIGINT');
      winston.info('\tSuccess');
    } catch (err) {
      winston.error(`\tFailed: ${err.message}`);
    }
  };

  const retryWorkflows = async () => {
    try {
      if (!noRetry && RUNNER_JOBS_RUNNING.length > 0) {
        winston.info(`Still pending jobs, retrying workflow...`);

        await Promise.all(
          RUNNER_JOBS_RUNNING.map(
            async (job) =>
              await cml.pipelineRerun({ id: job.pipeline, jobId: job.id })
          )
        );
      }
    } catch (err) {
      winston.error(err);
    }
  };

  const destroyTerraform = async () => {
    if (!tfResource) return;

    winston.info(`Waiting ${destroyDelay} seconds to destroy`);
    await sleep(destroyDelay);

    try {
      winston.debug(await tf.destroy({ dir: tfPath }));
    } catch (err) {
      winston.error(`\tFailed destroying terraform: ${err.message}`);
    }
  };

  if (error) {
    winston.error(error, { status: 'terminated' });
  } else {
    winston.info('runner status', { reason, status: 'terminated' });
  }

  if (!cloud) {
    try {
      await unregisterRunner();
      await retryWorkflows();
    } catch (err) {
      winston.error(`Error connecting the SCM: ${err.message}`);
    }
  }

  await destroyTerraform();

  process.exit(error ? 1 : 0);
};

const runCloud = async (opts) => {
  const runTerraform = async (opts) => {
    winston.info('Terraform apply...');

    const { token, repo, driver } = cml;
    const {
      tpiVersion,
      labels,
      idleTimeout,
      name,
      cmlVersion,
      single,
      dockerVolumes,
      cloud,
      cloudRegion: region,
      cloudType: type,
      cloudPermissionSet: permissionSet,
      cloudMetadata: metadata,
      cloudGpu: gpu,
      cloudHddSize: hddSize,
      cloudSshPrivate: sshPrivate,
      cloudSpot: spot,
      cloudSpotPrice: spotPrice,
      cloudStartupScript: startupScript,
      cloudAwsSecurityGroup: awsSecurityGroup,
      cloudAwsSubnet: awsSubnet,
      workdir
    } = opts;

    await tf.checkMinVersion();

    if (gpu === 'tesla')
      winston.warn(
        'GPU model "tesla" has been deprecated; please use "v100" instead.'
      );

    const tfPath = workdir;
    const tfMainPath = join(tfPath, 'main.tf');

    const tpl = tf.iterativeCmlRunnerTpl({
      tpiVersion,
      repo,
      token,
      driver,
      labels,
      cmlVersion,
      idleTimeout,
      name,
      single,
      cloud,
      region,
      type,
      permissionSet,
      metadata,
      gpu: gpu === 'tesla' ? 'v100' : gpu,
      hddSize,
      sshPrivate,
      spot,
      spotPrice,
      startupScript,
      awsSecurityGroup,
      awsSubnet,
      dockerVolumes
    });

    await fs.writeFile(tfMainPath, tpl);

    await tf.init({ dir: tfPath });
    await tf.apply({ dir: tfPath });

    const tfStatePath = join(tfPath, 'terraform.tfstate');
    const tfstate = await tf.loadTfState({ path: tfStatePath });

    return tfstate;
  };

  winston.info('Deploying cloud runner plan...');
  const tfstate = await runTerraform(opts);
  const { resources } = tfstate;
  for (const resource of resources) {
    if (resource.type.startsWith('iterative_')) {
      for (const { attributes } of resource.instances) {
        const nonSensitiveValues = {
          awsSecurityGroup: attributes.aws_security_group,
          awsSubnetId: attributes.aws_subnet_id,
          cloud: attributes.cloud,
          driver: attributes.driver,
          id: attributes.id,
          idleTimeout: attributes.idle_timeout,
          image: attributes.image,
          instanceGpu: attributes.instance_gpu,
          instanceHddSize: attributes.instance_hdd_size,
          instanceIp: attributes.instance_ip,
          instanceLaunchTime: attributes.instance_launch_time,
          instanceType: attributes.instance_type,
          instancePermissionSet: attributes.instance_permission_set,
          labels: attributes.labels,
          cmlVersion: attributes.cml_version,
          metadata: attributes.metadata,
          name: attributes.name,
          region: attributes.region,
          repo: attributes.repo,
          single: attributes.single,
          spot: attributes.spot,
          spotPrice: attributes.spot_price,
          timeouts: attributes.timeouts
        };
        winston.info(JSON.stringify(nonSensitiveValues));
      }
    }
  }
};

const runLocal = async (opts) => {
  winston.info(`Launching ${cml.driver} runner`);
  const {
    workdir,
    name,
    labels,
    single,
    idleTimeout,
    noRetry,
    dockerVolumes,
    tfResource,
    tpiVersion
  } = opts;

  if (tfResource) {
    await tf.checkMinVersion();

    const tfPath = workdir;
    await fs.mkdir(tfPath, { recursive: true });
    const tfMainPath = join(tfPath, 'main.tf');
    const tpl = tf.iterativeProviderTpl({ tpiVersion });
    await fs.writeFile(tfMainPath, tpl);

    await tf.init({ dir: tfPath });
    await tf.apply({ dir: tfPath });

    const path = join(tfPath, 'terraform.tfstate');
    const tfstate = await tf.loadTfState({ path });
    tfstate.resources = [
      JSON.parse(Buffer.from(tfResource, 'base64').toString('utf-8'))
    ];
    await tf.saveTfState({ tfstate, path });
  }

  if (process.platform === 'linux') {
    const acpiSock = net.connect('/var/run/acpid.socket');
    acpiSock.on('connect', () => {
      winston.info('Connected to acpid service.');
    });
    acpiSock.on('error', (err) => {
      winston.warn(
        `Error connecting to ACPI socket: ${err.message}. The acpid.service helps with instance termination detection.`
      );
    });
    acpiSock.on('data', (buf) => {
      const data = buf.toString().toLowerCase();
      if (data.includes('power') && data.includes('button')) {
        shutdown({ ...opts, reason: 'ACPI shutdown' });
      }
    });
  }

  const dataHandler = async (data) => {
    const logs = await cml.parseRunnerLog({ data, name });
    for (const log of logs) {
      winston.info('runner status', log);

      if (log.status === 'job_started') {
        const { job: id, pipeline, date } = log;
        RUNNER_JOBS_RUNNING.push({ id, pipeline, date });
      }

      if (log.status === 'job_ended') {
        RUNNER_JOBS_RUNNING.pop();
        if (single) await shutdown({ ...opts, reason: 'single job' });
      }
    }
  };

  const proc = await cml.startRunner({
    workdir,
    name,
    labels,
    single,
    idleTimeout,
    dockerVolumes
  });

  proc.stderr.on('data', dataHandler);
  proc.stdout.on('data', dataHandler);
  proc.on('disconnect', () =>
    shutdown({ ...opts, error: new Error('runner proccess lost') })
  );
  proc.on('close', (exit) => {
    const reason = `runner closed with exit code ${exit}`;
    if (exit === 0) shutdown({ ...opts, reason });
    else shutdown({ ...opts, error: new Error(reason) });
  });

  RUNNER = proc;
  if (idleTimeout > 0) {
    const watcher = setInterval(async () => {
      const idle = RUNNER_JOBS_RUNNING.length === 0;

      if (RUNNER_TIMER >= idleTimeout) {
        shutdown({ ...opts, reason: `timeout:${idleTimeout}` });
        clearInterval(watcher);
      }

      RUNNER_TIMER = idle ? RUNNER_TIMER + 1 : 0;
    }, 1000);
  }

  if (!noRetry) {
    if (cml.driver === 'github') {
      const watcherSeventyTwo = setInterval(() => {
        RUNNER_JOBS_RUNNING.forEach((job) => {
          if (
            new Date().getTime() - new Date(job.date).getTime() >
            GH_5_MIN_TIMEOUT
          ) {
            shutdown({ ...opts, reason: 'timeout:35days' });
            clearInterval(watcherSeventyTwo);
          }
        });
      }, 60 * 1000);
    }
  }
};

const run = async (opts) => {
  process.on('unhandledRejection', (reason) =>
    shutdown({ ...opts, error: new Error(reason) })
  );
  process.on('uncaughtException', (error) => shutdown({ ...opts, error }));

  ['SIGTERM', 'SIGINT', 'SIGQUIT'].forEach((signal) => {
    process.on(signal, () => shutdown({ ...opts, reason: signal }));
  });

  opts.workdir = opts.workdir || `${homedir()}/.cml/${opts.name}`;
  const {
    driver,
    repo,
    token,
    workdir,
    cloud,
    labels,
    name,
    reuse,
    reuseIdle,
    dockerVolumes
  } = opts;

  cml = new CML({ driver, repo, token });

  await cml.repoTokenCheck();

  if (dockerVolumes.length && cml.driver !== 'gitlab')
    winston.warn('Parameters --docker-volumes is only supported in gitlab');

  const runners = await cml.runners();

  const runner = await cml.runnerByName({ name, runners });
  if (runner) {
    if (!reuse)
      throw new Error(
        `Runner name ${name} is already in use. Please change the name or terminate the existing runner.`
      );
    winston.info(`Reusing existing runner named ${name}...`);
    process.exit(0);
  }

  if (
    reuse &&
    (await cml.runnersByLabels({ labels, runners })).find(
      (runner) => runner.online
    )
  ) {
    winston.info(
      `Reusing existing online runners with the ${labels} labels...`
    );
    process.exit(0);
  }

  if (reuseIdle) {
    if (driver === 'bitbucket') {
      winston.error('cml runner flag --reuse-idle is unsupported by bitbucket');
      process.exit(1);
    }
    winston.info(
      `Checking for existing idle runner matching labels: ${labels}.`
    );
    const currentRunners = await cml.runnersByLabels({ labels, runners });
    const availableRunner = currentRunners.find(
      (runner) => runner.online && !runner.busy
    );
    if (availableRunner) {
      winston.info('Found matching idle runner.', availableRunner);
      process.exit(0);
    }
  }

  if (driver === 'github') {
    winston.warn(
      'Github Actions timeout has been updated from 72h to 35 days. Update your workflow accordingly to be able to restart it automatically.'
    );
  }

  winston.info(`Preparing workdir ${workdir}...`);
  await fs.mkdir(workdir, { recursive: true });
  await fs.chmod(workdir, '766');

  if (cloud) await runCloud(opts);
  else await runLocal(opts);
};

exports.command = 'runner';
exports.description = 'Launch and register a self-hosted runner';

exports.handler = async (opts) => {
  if (process.env.RUNNER_NAME) {
    winston.warn(
      'ignoring RUNNER_NAME environment variable, use CML_RUNNER_NAME or --name instead'
    );
  }
  try {
    await run(opts);
  } catch (error) {
    await shutdown({ ...opts, error });
  }
};

exports.builder = (yargs) =>
  yargs.env('CML_RUNNER').options(
    kebabcaseKeys({
      driver: {
        type: 'string',
        choices: ['github', 'gitlab', 'bitbucket'],
        description:
          'Platform where the repository is hosted. If not specified, it will be inferred from the environment'
      },
      repo: {
        type: 'string',
        description:
          'Repository to be used for registering the runner. If not specified, it will be inferred from the environment'
      },
      token: {
        type: 'string',
        description:
          'Personal access token to register a self-hosted runner on the repository. If not specified, it will be inferred from the environment'
      },
      labels: {
        type: 'string',
        default: 'cml',
        description:
          'One or more user-defined labels for this runner (delimited with commas)'
      },
      idleTimeout: {
        type: 'string',
        default: '5 minutes',
        coerce: (val) =>
          /^-?\d+$/.test(val) ? parseInt(val) : timestring(val),
        description:
          'Time to wait for jobs before shutting down (e.g. "5min"). Use "never" to disable'
      },
      name: {
        type: 'string',
        default: `cml-${randid()}`,
        defaultDescription: 'cml-{ID}',
        description: 'Name displayed in the repository once registered'
      },
      noRetry: {
        type: 'boolean',
        description:
          'Do not restart workflow terminated due to instance disposal or GitHub Actions timeout'
      },
      single: {
        type: 'boolean',
        conflicts: ['reuse', 'reuseIdle'],
        description: 'Exit after running a single job'
      },
      reuse: {
        type: 'boolean',
        conflicts: ['single', 'reuseIdle'],
        description:
          "Don't launch a new runner if an existing one has the same name or overlapping labels"
      },
      reuseIdle: {
        type: 'boolean',
        conflicts: ['reuse', 'single'],
        description:
          'Only creates a new runner if the matching labels dont exist or are already busy.'
      },
      workdir: {
        type: 'string',
        hidden: true,
        alias: 'path',
        description: 'Runner working directory'
      },
      dockerVolumes: {
        type: 'array',
        default: [],
        description: 'Docker volumes. This feature is only supported in GitLab'
      },
      cloud: {
        type: 'string',
        choices: ['aws', 'azure', 'gcp', 'kubernetes'],
        description: 'Cloud to deploy the runner'
      },
      cloudRegion: {
        type: 'string',
        default: 'us-west',
        description:
          'Region where the instance is deployed. Choices: [us-east, us-west, eu-west, eu-north]. Also accepts native cloud regions'
      },
      cloudType: {
        type: 'string',
        description:
          'Instance type. Choices: [m, l, xl]. Also supports native types like i.e. t2.micro'
      },
      cloudPermissionSet: {
        type: 'string',
        default: '',
        description:
          'Specifies the instance profile in AWS or instance service account in GCP'
      },
      cloudMetadata: {
        type: 'array',
        string: true,
        default: [],
        coerce: (items) => {
          const keyValuePairs = items.map((item) => [
            ...item.split(/=(.+)/),
            null
          ]);
          return Object.fromEntries(keyValuePairs);
        },
        description:
          'Key Value pairs to associate cml-runner instance on the provider i.e. tags/labels "key=value"'
      },
      cloudGpu: {
        type: 'string',
        description:
          'GPU type. Choices: k80, v100, or native types e.g. nvidia-tesla-t4',
        coerce: (val) => (val === 'nogpu' ? undefined : val)
      },
      cloudHddSize: {
        type: 'number',
        description: 'HDD size in GB'
      },
      cloudSshPrivate: {
        type: 'string',
        coerce: (val) => val && val.replace(/\n/g, '\\n'),
        description:
          'Custom private RSA SSH key. If not provided an automatically generated throwaway key will be used'
      },
      cloudSpot: {
        type: 'boolean',
        description: 'Request a spot instance'
      },
      cloudSpotPrice: {
        type: 'number',
        default: -1,
        description:
          'Maximum spot instance bidding price in USD. Defaults to the current spot bidding price'
      },
      cloudStartupScript: {
        type: 'string',
        description:
          'Run the provided Base64-encoded Linux shell script during the instance initialization'
      },
      cloudAwsSecurityGroup: {
        type: 'string',
        default: '',
        description: 'Specifies the security group in AWS'
      },
      cloudAwsSubnet: {
        type: 'string',
        default: '',
        description: 'Specifies the subnet to use within AWS',
        alias: 'cloud-aws-subnet-id'
      },
      tpiVersion: {
        type: 'string',
        default: '>= 0.9.10',
        description:
          'Pin the iterative/iterative terraform provider to a specific version. i.e. "= 0.10.4" See: https://www.terraform.io/language/expressions/version-constraints',
        hidden: true
      },
      cmlVersion: {
        type: 'string',
        default: require('../../package.json').version,
        description: 'CML version to load on TPI instance',
        hidden: true
      },
      tfResource: {
        hidden: true,
        alias: 'tf_resource'
      },
      destroyDelay: {
        type: 'number',
        default: 10,
        hidden: true,
        description:
          'Seconds to wait for collecting logs on failure (https://github.com/iterative/cml/issues/413)'
      }
    })
  );
