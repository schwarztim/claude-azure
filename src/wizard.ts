/**
 * Setup wizard for Claude Azure
 */
import inquirer from 'inquirer';
import chalk from 'chalk';
import ora from 'ora';
import axios from 'axios';
import { setConfig, type AppConfig, type AzureConfig } from './config.js';

export async function runWizard(): Promise<boolean> {
  console.log();
  console.log(chalk.cyan.bold('  Claude Azure Setup'));
  console.log(chalk.gray('  ─────────────────────────────────────'));
  console.log();

  const { provider } = await inquirer.prompt([
    {
      type: 'list',
      name: 'provider',
      message: 'Select your AI provider:',
      choices: [
        { name: chalk.blue('Azure OpenAI') + chalk.gray(' - Use Azure-hosted models'), value: 'azure' },
        { name: chalk.green('OpenAI') + chalk.gray(' - Use OpenAI API directly'), value: 'openai' },
        { name: chalk.yellow('Anthropic') + chalk.gray(' - Use Anthropic API directly'), value: 'anthropic' },
      ],
    },
  ]);

  let config: AppConfig;

  if (provider === 'azure') {
    config = await setupAzure();
  } else if (provider === 'openai') {
    config = await setupOpenAI();
  } else {
    config = await setupAnthropic();
  }

  setConfig(config);

  console.log();
  console.log(chalk.green('✓') + ' Configuration saved!');
  console.log(chalk.gray(`  Config file: ~/.claude-azure/config.json`));
  console.log();

  return true;
}

async function setupAzure(): Promise<AppConfig> {
  console.log();
  console.log(chalk.blue('Azure OpenAI Configuration'));
  console.log(chalk.gray('Get these from Azure Portal → Azure OpenAI → Keys and Endpoint'));
  console.log();

  const answers = await inquirer.prompt([
    {
      type: 'input',
      name: 'endpoint',
      message: 'Azure OpenAI Endpoint:',
      validate: (input: string) => {
        if (!input.startsWith('https://')) {
          return 'Endpoint must start with https://';
        }
        return true;
      },
      filter: (input: string) => input.replace(/\/$/, ''), // Remove trailing slash
    },
    {
      type: 'password',
      name: 'apiKey',
      message: 'Azure OpenAI API Key:',
      mask: '*',
      validate: (input: string) => input.length > 0 || 'API key is required',
    },
    {
      type: 'input',
      name: 'apiVersion',
      message: 'API Version:',
      default: '2024-12-01-preview',
    },
  ]);

  // Choose deployment mode
  console.log();
  console.log(chalk.blue('Deployment Mode'));
  console.log(chalk.gray('Choose how you want to configure model deployments'));
  console.log();

  const { mode } = await inquirer.prompt([
    {
      type: 'list',
      name: 'mode',
      message: 'Select deployment mode:',
      choices: [
        {
          name: chalk.gray('Tiered') + ' - Separate deployments for different model sizes',
          value: 'tiered',
        },
        {
          name: chalk.gray('Model Router') + ' - Single deployment for all models',
          value: 'router',
        },
      ],
    },
  ]);

  let deploymentConfig: { router?: string; deployments?: { opus: string; sonnet: string; haiku: string } };

  if (mode === 'router') {
    const router = await inquirer.prompt([
      {
        type: 'input',
        name: 'deployment',
        message: 'Model Router deployment name:',
        validate: (input: string) => input.length > 0 || 'Deployment name is required',
      },
    ]);
    deploymentConfig = { router: router.deployment };
  } else {
    const models = await inquirer.prompt([
      {
        type: 'input',
        name: 'opus',
        message: 'Opus/Large model deployment:',
        default: 'gpt-4o',
      },
      {
        type: 'input',
        name: 'sonnet',
        message: 'Sonnet/Medium model deployment:',
        default: 'gpt-4o',
      },
      {
        type: 'input',
        name: 'haiku',
        message: 'Haiku/Small model deployment:',
        default: 'gpt-4o-mini',
      },
    ]);
    deploymentConfig = {
      deployments: {
        opus: models.opus,
        sonnet: models.sonnet,
        haiku: models.haiku,
      },
    };
  }

  // Test connection
  const spinner = ora('Testing Azure connection...').start();
  const testDeployment = deploymentConfig.router || deploymentConfig.deployments?.sonnet;

  try {
    const testUrl = `${answers.endpoint}/openai/deployments/${testDeployment}/chat/completions?api-version=${answers.apiVersion}`;
    await axios.post(
      testUrl,
      {
        messages: [{ role: 'user', content: 'Hi' }],
        max_tokens: 5,
      },
      {
        headers: {
          'api-key': answers.apiKey,
          'Content-Type': 'application/json',
        },
        timeout: 10000,
      }
    );
    spinner.succeed('Azure connection successful!');
  } catch (error: any) {
    if (error.response?.status === 401) {
      spinner.fail('Invalid API key');
      throw new Error('Azure authentication failed');
    } else if (error.response?.status === 404) {
      spinner.warn('Deployment not found - please verify deployment names');
    } else {
      spinner.warn(`Connection test: ${error.message}`);
    }
  }

  const azure: AzureConfig = {
    endpoint: answers.endpoint,
    apiKey: answers.apiKey,
    apiVersion: answers.apiVersion,
    deployments: deploymentConfig.deployments || { opus: '', sonnet: '', haiku: '' },
    router: deploymentConfig.router,
  };

  return { provider: 'azure', azure };
}

async function setupOpenAI(): Promise<AppConfig> {
  console.log();
  console.log(chalk.green('OpenAI Configuration'));
  console.log();

  const answers = await inquirer.prompt([
    {
      type: 'password',
      name: 'apiKey',
      message: 'OpenAI API Key:',
      mask: '*',
      validate: (input: string) => input.startsWith('sk-') || 'API key should start with sk-',
    },
    {
      type: 'input',
      name: 'baseUrl',
      message: 'Base URL (optional):',
      default: 'https://api.openai.com/v1',
    },
  ]);

  return {
    provider: 'openai',
    openai: {
      apiKey: answers.apiKey,
      baseUrl: answers.baseUrl,
    },
  };
}

async function setupAnthropic(): Promise<AppConfig> {
  console.log();
  console.log(chalk.yellow('Anthropic Configuration'));
  console.log(chalk.gray('This will use Anthropic directly - no proxy needed'));
  console.log();

  const answers = await inquirer.prompt([
    {
      type: 'password',
      name: 'apiKey',
      message: 'Anthropic API Key:',
      mask: '*',
      validate: (input: string) => input.startsWith('sk-ant-') || 'API key should start with sk-ant-',
    },
  ]);

  return {
    provider: 'anthropic',
    anthropic: {
      apiKey: answers.apiKey,
    },
  };
}
