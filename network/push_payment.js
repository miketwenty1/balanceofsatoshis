const asyncAuto = require('async/auto');
const {findKey} = require('ln-sync');
const {formatTokens} = require('ln-sync');
const {getChannels} = require('ln-service');
const {getNetwork} = require('ln-sync');
const {getPeerLiquidity} = require('ln-sync');
const {returnResult} = require('asyncjs-util');

const {getCoingeckoRates} = require('./../fiat');
const {parseAmount} = require('./../display');
const probeDestination = require('./probe_destination');

const coins = ['BTC', 'LTC'];
const fiats = ['EUR', 'USD'];
const {isArray} = Array;
const isPublicKey = n => /^[0-9A-F]{66}$/i.test(n);
const maxQuizLength = 10;
const rateAsTokens = rate => 1e8 / rate;
const sumOf = arr => arr.reduce((sum, n) => sum + n, Number());
const minQuiz = 2;
const minTokens = 1;
const networks = {btc: 'BTC', btctestnet: 'BTC', ltc: 'LTC'};
const quizStart = 80509;
const tokAsBigTok = tokens => !tokens ? undefined : (tokens / 1e8).toFixed(8);
const utf8AsHex = n => Buffer.from(n, 'utf8').toString('hex');

/** Push a payment to a destination

  {
    amount: <Amount to Push Tokens String>
    destination: <Destination Public Key Hex String>
    [in_through]: <Pay In Through Peer String>
    [is_dry_run]: <Do Not Push Payment Bool>
    lnd: <Authenticated LND API Object>
    logger: <Winston Logger Object>
    max_fee: <Maximum Fee Tokens Number>
    [message]: <Message to Include With Payment String>
    [out_through]: <Pay Out Through Peer String>
    quiz_answers: [<Quiz Answer String>]
    request: <Request Function>
  }
*/
module.exports = (args, cbk) => {
  return new Promise((resolve, reject) => {
    return asyncAuto({
      // Check arguments
      validate: cbk => {
        if (!args.amount) {
          return cbk([400, 'ExpectedAmountToSendInPushPayment']);
        }

        if (!isPublicKey(args.destination)) {
          return cbk([400, 'ExpectedDestinationToPushPaymentTo']);
        }

        if (!!args.in_through && !!isArray(args.in_through)) {
          return cbk([400, 'MultipleInboundPeersNotSupported']);
        }

        if (!args.lnd) {
          return cbk([400, 'ExpectedAuthenticatedLndToPushPayment']);
        }

        if (!args.logger) {
          return cbk([400, 'ExpectedLoggerToPushPayment']);
        }

        if (args.max_fee === undefined) {
          return cbk([400, 'ExpectedMaxFeeAmountToPushPayment']);
        }

        if (!!args.out_through && !!isArray(args.out_through)) {
          return cbk([400, 'MultipleOutboundPeersNotSupported']);
        }

        if (!isArray(args.quiz_answers)) {
          return cbk([400, 'ExpectedMultipleQuizAnswersToSend']);
        }

        if (!!args.quiz_answers.length && !args.message) {
          return cbk([400, 'ExpectedQuizQuestionMessageToSendQuiz']);
        }

        if (!!args.quiz_answers.length && args.quiz_answers.length < minQuiz) {
          return cbk([400, 'ExpectedMultipleQuizAnswersToSend']);
        }

        if (args.quiz_answers.length > maxQuizLength) {
          return cbk([400, 'TooManyAnswersForQuiz', {max: maxQuizLength}]);
        }

        if (!args.request) {
          return cbk([400, 'ExpectedRequestFunctionToPushPayment']);
        }

        return cbk();
      },

      // Get channels with the peer in order to populate liquidity
      getChannels: ['validate', ({}, cbk) => {
        return getChannels({lnd: args.lnd}, cbk);
      }],

      // Get network name
      getNetwork: ['validate', ({}, cbk) => getNetwork({lnd: args.lnd}, cbk)],

      // Get the current price of BTCUSD
      getFiatPrice: ['validate', ({}, cbk) => {
        return getCoingeckoRates({
          request: args.request,
          symbols: [].concat(coins).concat(fiats),
        },
        cbk);
      }],

      // Determine the inbound node public key
      getInKey: ['getChannels', ({getChannels}, cbk) => {
        // Exit early when there is no inbound constraint
        if (!args.in_through) {
          return cbk();
        }

        return findKey({
          channels: getChannels.channels,
          lnd: args.lnd,
          query: args.in_through,
        },
        (err, res) => {
          if (!!err) {
            return cbk(err);
          }

          return cbk(null, res.public_key);
        });
      }],

      // Determine the outbound peer public key
      getOutKey: ['getChannels', ({getChannels}, cbk) => {
        // Exit early when there is no outbound constraint
        if (!args.out_through) {
          return cbk();
        }

        return findKey({
          channels: getChannels.channels,
          lnd: args.lnd,
          query: args.out_through,
        },
        (err, res) => {
          if (!!err) {
            return cbk(err);
          }

          return cbk(null, res.public_key);
        });
      }],

      // Fiat rates
      fiatRates: [
        'getFiatPrice',
        'getNetwork',
        ({getFiatPrice, getNetwork}, cbk) =>
      {
        const coin = getFiatPrice.tickers.find(({ticker}) => {
          return ticker === networks[getNetwork.network];
        });

        const rates = fiats.map(fiat => {
          const {rate} = getFiatPrice.tickers.find(n => n.ticker === fiat);

          return {fiat, unit: rateAsTokens(rate) * coin.rate};
        });

        return cbk(null, rates);
      }],

      // Parse the amount specified
      parseAmount: [
        'fiatRates',
        'getChannels',
        'getNetwork',
        'getOutKey',
        ({fiatRates, getChannels, getNetwork, getOutKey}, cbk) =>
      {
        // Total remote balance including pending if pending fails
        const inbound = getChannels.channels
          .filter(n => n.partner_public_key === args.destination)
          .reduce((sum, chan) => {
            // Treat incoming payment as if they were still remote balance
            const inbound = chan.pending_payments.filter(n => !n.is_outgoing);

            const pending = sumOf(inbound.map(({tokens}) => tokens));

            return sum + chan.remote_balance + pending;
          },
          Number());

        // Calculate the outbound peer inbound liquidity
        const outInbound = getChannels.channels
          .filter(n => n.partner_public_key === getOutKey)
          .reduce((sum, chan) => {
            // Treat incoming payment as if they were still remote balance
            const inbound = chan.pending_payments.filter(n => !n.is_outgoing);

            const pending = sumOf(inbound.map(({tokens}) => tokens));

            return sum + chan.remote_balance + pending;
          },
          Number());

        // Calculate the outbound peer outbound liquidity
        const outOutbound = getChannels.channels
          .filter(n => n.partner_public_key === getOutKey)
          .reduce((sum, chan) => {
            // Treat outgoing payment as if they were still local balance
            const outbound = chan.pending_payments
              .filter(n => !!n.is_outgoing);

            const pending = sumOf(outbound.map(({tokens}) => tokens));

            return sum + chan.local_balance + pending;
          },
          Number());

        // Total local balance including pending if pending fails
        const outbound = getChannels.channels
          .filter(n => n.partner_public_key === args.destination)
          .reduce((sum, chan) => {
            // Treat outgoing payment as if they were still local balance
            const outbound = chan.pending_payments
              .filter(n => !!n.is_outgoing);

            const pending = sumOf(outbound.map(({tokens}) => tokens));

            return sum + chan.local_balance + pending;
          },
          Number());

        // Variables to use in amount
        const variables = {
          inbound,
          outbound,
          eur: fiatRates.find(n => n.fiat === 'EUR').unit,
          liquidity: sumOf(
            getChannels.channels
              .filter(n => n.partner_public_key === args.destination)
              .map(n => n.capacity)
          ),
          out_inbound: outInbound,
          out_liquidity: sumOf(
            getChannels.channels
              .filter(n => n.partner_public_key === getOutKey)
              .map(n => n.capacity)
          ),
          out_outbound: outOutbound,
          usd: fiatRates.find(n => n.fiat === 'USD').unit,
        };

        try {
          return cbk(null, parseAmount({variables, amount: args.amount}));
        } catch (err) {
          return cbk([400, 'FailedToParsePushAmount', err]);
        }
      }],

      // Push the amount to the destination
      push: [
        'getInKey',
        'getOutKey',
        'parseAmount',
        ({getInKey, getOutKey, parseAmount}, cbk) =>
      {
        if (parseAmount.tokens < minTokens) {
          return cbk([400, 'ExpectedNonZeroAmountToPushPayment']);
        }

        args.logger.info({
          paying: formatTokens({tokens: parseAmount.tokens}).display,
          to: args.destination,
        });

        if (!!args.is_dry_run) {
          return cbk([400, 'PushPaymentDryRun']);
        }

        return probeDestination({
          destination: args.destination,
          lnd: args.lnd,
          logger: args.logger,
          in_through: getInKey,
          is_push: true,
          is_real_payment: true,
          max_fee: args.max_fee,
          message: args.message,
          messages: args.quiz_answers.map((answer, i) => ({
            type: (quizStart + i).toString(),
            value: utf8AsHex(answer),
          })),
          out_through: getOutKey,
          tokens: parseAmount.tokens,
        },
        cbk);
      }],

      // Get adjusted outbound liquidity after push
      getAdjustedOutbound: ['push', ({push}, cbk) => {
        // Exit early when the payment failed
        if (!push.preimage) {
          return cbk([503, 'UnexpectedSendPaymentFailure']);
        }

        // Exit early when there is no outbound constraint
        if (!args.out_through) {
          return cbk();
        }

        const [out] = push.relays;

        return getPeerLiquidity({
          lnd: args.lnd,
          public_key: out,
          settled: push.id,
        },
        cbk);
      }],

      // Final liquidity outcome
      liquidity: [
        'getAdjustedOutbound',
        'push',
        ({getAdjustedOutbound, push}, cbk) =>
      {
        if (!getAdjustedOutbound) {
          return cbk();
        }

        const [out] = push.relays;
        const outOpeningIn = getAdjustedOutbound.inbound_opening;
        const outOpeningOut = getAdjustedOutbound.outbound_opening;
        const outPendingIn = getAdjustedOutbound.inbound_pending;
        const outPendingOut = getAdjustedOutbound.outbound_pending;

        args.logger.info({
          liquidity_change: {
            increased_inbound_on: `${getAdjustedOutbound.alias} ${out}`.trim(),
            liquidity_inbound: tokAsBigTok(getAdjustedOutbound.inbound),
            liquidity_inbound_opening: tokAsBigTok(outOpeningIn),
            liquidity_inbound_pending: tokAsBigTok(outPendingIn),
            liquidity_outbound: tokAsBigTok(getAdjustedOutbound.outbound),
            liquidity_outbound_opening: tokAsBigTok(outOpeningOut),
            liquidity_outbound_pending: tokAsBigTok(outPendingOut),
          },
        });

        return cbk();
      }],
    },
    returnResult({reject, resolve, of: 'push'}, cbk));
  });
};
