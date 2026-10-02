type Props = { account: string };

function greet(props: Props): string {
  return `Hello, ${props.user}`;
}

document.querySelector('#app')!.textContent = greet({ account: 'AutoDeploy' });
