import { formatPrice } from './price';

const price = document.querySelector<HTMLElement>('#price');
if (price) price.textContent = formatPrice(18900);
