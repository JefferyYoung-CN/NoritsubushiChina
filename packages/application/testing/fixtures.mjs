// Synthetic fixtures shared by the public test suite.
//
// The tests that need a licensed data snapshot (real topology, scenario
// archives, source reviews) live in the private workspace together with that
// data. This repository only ships checks that run on the synthetic demo
// dataset in demo/ or on in-memory fixtures.

export const errorCode = code => error => error.code === code && typeof error.path === 'string';
