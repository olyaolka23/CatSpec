class Store {}

function createStore(): Store {
  return new Store();
}

interface Options {}

const internal = 1;

export { Store, createStore as create };
export type { Options };
export default Store;
