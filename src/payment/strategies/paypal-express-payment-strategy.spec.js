import { createAction } from '@bigcommerce/data-store';
import { Observable } from 'rxjs';
import { merge } from 'lodash';
import { createCheckoutClient, createCheckoutStore } from '../../checkout';
import { OrderFinalizationNotRequiredError } from '../../order/errors';
import { getOrderRequestBody, getIncompleteOrder, getIncompleteOrderState, getSubmittedOrder } from '../../order/internal-orders.mock';
import { FINALIZE_ORDER_REQUESTED, SUBMIT_ORDER_SUCCEEDED } from '../../order/order-action-types';
import { OrderActionCreator } from '../../order';
import { getPaypalExpress } from '../payment-methods.mock';
import * as paymentStatusTypes from '../payment-status-types';
import PaypalExpressPaymentStrategy from './paypal-express-payment-strategy';

describe('PaypalExpressPaymentStrategy', () => {
    let finalizeOrderAction;
    let order;
    let orderActionCreator;
    let paymentMethod;
    let paypalSdk;
    let scriptLoader;
    let store;
    let strategy;
    let submitOrderAction;

    beforeEach(() => {
        orderActionCreator = new OrderActionCreator(createCheckoutClient());

        paypalSdk = {
            checkout: {
                setup: jest.fn(),
                initXO: jest.fn(),
                startFlow: jest.fn(),
                closeFlow: jest.fn(),
            },
        };

        scriptLoader = {
            loadScript: jest.fn(() => {
                window.paypal = paypalSdk;

                return Promise.resolve();
            }),
        };

        store = createCheckoutStore({
            order: getIncompleteOrderState(),
        });

        paymentMethod = getPaypalExpress();
        finalizeOrderAction = Observable.of(createAction(FINALIZE_ORDER_REQUESTED));
        submitOrderAction = Observable.of(createAction(SUBMIT_ORDER_SUCCEEDED, { order }));

        order = merge({}, getSubmittedOrder(), {
            payment: {
                id: 'paypalexpress',
                redirectUrl: 'https://s1504075966.bcapp.dev/checkout',
            },
        });

        jest.spyOn(window.location, 'assign').mockImplementation(() => {});

        jest.spyOn(store, 'dispatch');

        jest.spyOn(orderActionCreator, 'finalizeOrder')
            .mockReturnValue(finalizeOrderAction);

        jest.spyOn(orderActionCreator, 'submitOrder')
            .mockReturnValue(submitOrderAction);

        strategy = new PaypalExpressPaymentStrategy(store, orderActionCreator, scriptLoader);
    });

    afterEach(() => {
        window.location.assign.mockReset();
    });

    describe('#initialize()', () => {
        describe('if in-context checkout is enabled', () => {
            it('loads Paypal SDK', async () => {
                await strategy.initialize({ paymentMethod });

                expect(scriptLoader.loadScript).toHaveBeenCalledWith('//www.paypalobjects.com/api/checkout.min.js');
            });

            it('initializes Paypal SDK', async () => {
                await strategy.initialize({ paymentMethod });

                expect(paypalSdk.checkout.setup).toHaveBeenCalledWith(paymentMethod.config.merchantId, {
                    button: 'paypal-button',
                    environment: 'production',
                });
            });

            it('returns checkout state', async () => {
                const output = await strategy.initialize({ paymentMethod });

                expect(output).toEqual(store.getState());
            });
        });

        describe('if in-context checkout is not enabled', () => {
            beforeEach(() => {
                paymentMethod.config.merchantId = null;
            });

            it('does not load Paypal SDK', async () => {
                await strategy.initialize({ paymentMethod });

                expect(scriptLoader.loadScript).not.toHaveBeenCalled();
            });

            it('does not initialize Paypal SDK', async () => {
                await strategy.initialize({ paymentMethod });

                expect(paypalSdk.checkout.setup).not.toHaveBeenCalled();
            });

            it('returns checkout state', async () => {
                const output = await strategy.initialize({ paymentMethod });

                expect(output).toEqual(store.getState());
            });
        });
    });

    describe('#execute()', () => {
        let payload;

        beforeEach(() => {
            payload = merge({}, getOrderRequestBody(), {
                payment: { name: paymentMethod.id },
            });
        });

        describe('if in-context checkout is enabled', () => {
            beforeEach(async () => {
                await strategy.initialize({ paymentMethod });
            });

            it('opens in-context modal', async () => {
                strategy.execute(payload);
                await new Promise((resolve) => process.nextTick(resolve));

                expect(paypalSdk.checkout.initXO).toHaveBeenCalled();
            });

            it('starts in-context payment flow', async () => {
                strategy.execute(payload);
                await new Promise((resolve) => process.nextTick(resolve));

                expect(paypalSdk.checkout.startFlow).toHaveBeenCalledWith(order.payment.redirectUrl);
            });

            it('does not open in-context modal if payment is already acknowledged', async () => {
                store = createCheckoutStore({
                    order: merge(getIncompleteOrderState(), {
                        data: { payment: { status: paymentStatusTypes.ACKNOWLEDGE } },
                    }),
                });

                strategy = new PaypalExpressPaymentStrategy(store, orderActionCreator, scriptLoader);

                strategy.execute(payload);
                await new Promise((resolve) => process.nextTick(resolve));

                expect(paypalSdk.checkout.initXO).not.toHaveBeenCalled();
                expect(paypalSdk.checkout.startFlow).not.toHaveBeenCalled();
            });

            it('does not open in-context modal if payment is already finalized', async () => {
                store = createCheckoutStore({
                    order: merge(getIncompleteOrderState(), {
                        data: { payment: { status: paymentStatusTypes.FINALIZE } },
                    }),
                });

                strategy = new PaypalExpressPaymentStrategy(store, orderActionCreator, scriptLoader);

                strategy.execute(payload);
                await new Promise((resolve) => process.nextTick(resolve));

                expect(paypalSdk.checkout.initXO).not.toHaveBeenCalled();
                expect(paypalSdk.checkout.startFlow).not.toHaveBeenCalled();
            });

            it('submits order with payment data', async () => {
                const options = {};

                strategy.execute(payload, options);
                await new Promise((resolve) => process.nextTick(resolve));

                expect(orderActionCreator.submitOrder).toHaveBeenCalledWith(payload, true, options);
                expect(store.dispatch).toHaveBeenCalledWith(submitOrderAction);
            });

            it('does not redirect shopper directly if order submission is successful', async () => {
                strategy.execute(payload);
                await new Promise((resolve) => process.nextTick(resolve));

                expect(window.location.assign).not.toHaveBeenCalled();
            });
        });

        describe('if in-context checkout is not enabled', () => {
            beforeEach(async () => {
                paymentMethod.config.merchantId = null;

                await strategy.initialize({ paymentMethod });
            });

            it('does not open in-context modal', async () => {
                strategy.execute(payload);
                await new Promise((resolve) => process.nextTick(resolve));

                expect(paypalSdk.checkout.initXO).not.toHaveBeenCalled();
            });

            it('does not start in-context payment flow', async () => {
                strategy.execute(payload);
                await new Promise((resolve) => process.nextTick(resolve));

                expect(paypalSdk.checkout.startFlow).not.toHaveBeenCalled();
            });

            it('submits order with payment data', async () => {
                const options = {};

                strategy.execute(payload, options);
                await new Promise((resolve) => process.nextTick(resolve));

                expect(orderActionCreator.submitOrder).toHaveBeenCalledWith(payload, true, options);
                expect(store.dispatch).toHaveBeenCalledWith(submitOrderAction);
            });

            it('redirects shopper directly if order submission is successful', async () => {
                strategy.execute(payload);
                await new Promise((resolve) => process.nextTick(resolve));

                expect(window.location.assign).toHaveBeenCalledWith(order.payment.redirectUrl);
            });

            it('does not redirect shopper if payment is already acknowledged', async () => {
                store = createCheckoutStore({
                    order: merge(getIncompleteOrderState(), {
                        data: { payment: { status: paymentStatusTypes.ACKNOWLEDGE } },
                    }),
                });

                strategy = new PaypalExpressPaymentStrategy(store, orderActionCreator, scriptLoader);

                strategy.execute(payload);
                await new Promise((resolve) => process.nextTick(resolve));

                expect(window.location.assign).not.toHaveBeenCalled();
            });

            it('does not redirect shopper if payment is already finalized', async () => {
                store = createCheckoutStore({
                    order: merge(getIncompleteOrderState(), {
                        data: { payment: { status: paymentStatusTypes.FINALIZE } },
                    }),
                });

                strategy = new PaypalExpressPaymentStrategy(store, orderActionCreator, scriptLoader);

                strategy.execute(payload);
                await new Promise((resolve) => process.nextTick(resolve));

                expect(window.location.assign).not.toHaveBeenCalled();
            });
        });
    });

    describe('#finalize()', () => {
        let order;

        beforeEach(async () => {
            order = merge({}, getSubmittedOrder(), {
                payment: {
                    id: 'paypalexpress',
                    redirectUrl: 'https://s1504075966.bcapp.dev/checkout',
                },
            });

            jest.spyOn(store.getState().checkout, 'getOrder').mockReturnValue(order);

            await strategy.initialize({ paymentMethod });
        });

        it('finalizes order if order is created and payment is acknowledged', async () => {
            order.payment.status = paymentStatusTypes.ACKNOWLEDGE;

            await strategy.finalize();

            expect(orderActionCreator.finalizeOrder).toHaveBeenCalled();
            expect(store.dispatch).toHaveBeenCalledWith(finalizeOrderAction);
        });

        it('finalizes order if order is created and payment is finalized', async () => {
            order.payment.status = paymentStatusTypes.FINALIZE;

            await strategy.finalize();

            expect(orderActionCreator.finalizeOrder).toHaveBeenCalled();
            expect(store.dispatch).toHaveBeenCalledWith(finalizeOrderAction);
        });

        it('does not finalize order if order is not created', async () => {
            jest.spyOn(store.getState().checkout, 'getOrder').mockReturnValue(getIncompleteOrder());

            try {
                await strategy.finalize();
            } catch (error) {
                expect(error).toBeInstanceOf(OrderFinalizationNotRequiredError);
                expect(orderActionCreator.finalizeOrder).not.toHaveBeenCalled();
                expect(store.dispatch).not.toHaveBeenCalledWith(finalizeOrderAction);
            }
        });

        it('does not finalize order if order is not finalized or acknowledged', async () => {
            try {
                await strategy.finalize();
            } catch (error) {
                expect(error).toBeInstanceOf(OrderFinalizationNotRequiredError);
                expect(orderActionCreator.finalizeOrder).not.toHaveBeenCalled();
                expect(store.dispatch).not.toHaveBeenCalledWith(finalizeOrderAction);
            }
        });
    });

    describe('#deinitialize()', () => {
        describe('if in-context checkout is enabled', () => {
            it('ends paypal flow', async () => {
                await strategy.initialize({ paymentMethod });
                await strategy.deinitialize();

                expect(paypalSdk.checkout.closeFlow).toHaveBeenCalled();
            });

            it('does not end paypal flow if it is not initialized', async () => {
                await strategy.deinitialize();

                expect(paypalSdk.checkout.closeFlow).not.toHaveBeenCalled();
            });

            it('returns checkout state', async () => {
                expect(await strategy.deinitialize()).toEqual(store.getState());
            });
        });

        describe('if in-context checkout is not enabled', () => {
            beforeEach(() => {
                paymentMethod.config.merchantId = null;
            });

            it('does not end paypal flow', async () => {
                await strategy.initialize({ paymentMethod });
                await strategy.deinitialize();

                expect(paypalSdk.checkout.closeFlow).not.toHaveBeenCalled();
            });

            it('returns checkout state', async () => {
                expect(await strategy.deinitialize()).toEqual(store.getState());
            });
        });
    });
});
