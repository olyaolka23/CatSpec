export const double = (x: number): number => x * 2;

export const fetchUser = async (id: string): Promise<User> => {
  return api.get(id);
};

export const legacy = function named(a: string) {
  return a;
};

const internal = () => 1;

export const value = 42;
